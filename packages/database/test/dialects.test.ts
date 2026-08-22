import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Application } from '@elvel/core'
import { reachable } from '../../../tests/support/dialects.ts'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { ConnectionManager } from '../src/connection/manager.ts'
import { ReadWriteConnection } from '../src/connection/read-write.ts'
import { Migrator } from '../src/migrations/migrator.ts'
import { MigrationRepository } from '../src/migrations/repository.ts'
import { setAttributeEncrypter } from '../src/model/casts.ts'
import { Model, type Pivot } from '../src/model/model.ts'
import { QueryBuilder } from '../src/query/builder.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

/**
 * Cross-dialect conformance.
 *
 * Everything else in this package asserts the SQL we generate. This file runs
 * that SQL against real Postgres and MySQL servers, because a grammar can be
 * perfectly plausible and still be rejected: placeholder style, RETURNING
 * support, upsert syntax and DDL-in-transaction all differ, and only a server
 * can tell us we got them right.
 *
 * Dialects whose server is unreachable are skipped with a note rather than
 * failing, so the suite stays green on a machine without them. Override the
 * defaults with TEST_POSTGRES_URL / TEST_MYSQL_URL.
 */

const PREFIX = `elvel_t${Date.now().toString(36)}`

/**
 * The matrix, provisioning and reachability all come from
 * `tests/support/dialects.ts`, which four suites now share. It used to live here,
 * and living here was the problem: two other suites asked to connect *to*
 * `elvel_test` rather than create it, so they only reached Postgres and MySQL
 * when this file happened to run first.
 */
const available = await reachable('dialect')

test('sqlite is always part of the matrix', () => {
  expect(available.map((candidate) => candidate.name)).toContain('sqlite')
})

for (const { name, config } of available) {
  describe(`dialect: ${name}`, () => {
    let connection: BunSqlConnection
    let schema: SchemaBuilder

    const users = `${PREFIX}_users`
    const posts = `${PREFIX}_posts`
    const tags = `${PREFIX}_tags`
    const taggables = `${PREFIX}_taggables`

    class User extends Model {
      static override table = users
      static override fillable = ['name', 'email', 'votes', 'active', 'meta']
      static override casts = { votes: 'int', active: 'boolean', meta: 'json' } as never

      declare id: number
      declare name: string
      declare votes: number
      declare active: boolean
      declare meta: Record<string, unknown> | null

      articles() {
        return this.hasMany(Post, 'user_id')
      }

      labels() {
        return this.morphToMany(Tag, 'taggable', taggables, 'taggable_id', 'tag_id')
          .withPivot('note')
          .withTimestamps()
      }

      latestArticle() {
        return this.latestOfMany(Post, 'created_at', 'user_id')
      }
    }

    class Tag extends Model {
      static override table = tags
      static override fillable = ['label']
      static override timestamps = false

      declare id: number
      declare label: string

      taggedUsers() {
        return this.morphedByMany(User, 'taggable', taggables, 'tag_id', 'taggable_id')
      }
    }

    class Post extends Model {
      static override table = posts
      static override fillable = ['title', 'user_id', 'votes', 'published']

      declare id: number
      declare title: string

      author() {
        return this.belongsTo(User, 'user_id')
      }

      labels() {
        return this.morphToMany(Tag, 'taggable', taggables, 'taggable_id', 'tag_id')
      }
    }

    beforeAll(async () => {
      connection = await BunSqlConnection.make(name, config)
      schema = new SchemaBuilder(connection)

      await schema.dropIfExists(posts)
      await schema.dropIfExists(users)

      await schema.create(users, (table) => {
        table.id()
        table.string('name')
        table.string('email').nullable()
        table.integer('votes').default(0)
        table.boolean('active').default(true)
        table.text('meta').nullable()
        table.text('secret').nullable()
        table.string('secret_index').nullable()
        table.decimal('balance', 8, 2).default(0)
        table.timestamps()
        table.unique(['email'])
      })

      await schema.create(posts, (table) => {
        table.id()
        table.foreignId('user_id')
        table.string('title')
        table.integer('votes').default(0)
        table.boolean('published').default(false)
        table.timestamps()
        table.foreign(['user_id']).references(['id']).on(users).cascadeOnDelete()
      })

      await schema.create(taggables, (table) => {
        table.foreignId('tag_id')
        table.foreignId('taggable_id')
        table.string('taggable_type')
        table.string('note').nullable()
        table.timestamp('created_at').nullable()
        table.timestamp('updated_at').nullable()
      })

      await schema.create(tags, (table) => {
        table.id()
        table.string('label')
        table.timestamps()
      })
    })

    afterAll(async () => {
      await schema.dropIfExists(taggables)
      await schema.dropIfExists(tags)
      await schema.dropIfExists(posts)
      await schema.dropIfExists(users)
      await connection.disconnect()
    })

    function table(target = users) {
      return new QueryBuilder(connection, target)
    }

    async function truncate() {
      await table(taggables).delete()
      await table(tags).delete()
      await table(posts).delete()
      await table(users).delete()
    }

    describe('schema', () => {
      test('the tables it created really exist', async () => {
        expect(await schema.hasTable(users)).toBe(true)
        expect(await schema.hasColumn(users, 'name')).toBe(true)
        expect(await schema.hasColumn(users, 'nope')).toBe(false)
      })

      test('the column listing reports every column', async () => {
        const columns = await schema.getColumnListing(users)

        expect(columns).toContain('id')
        expect(columns).toContain('created_at')
        expect(columns).toContain('balance')
      })
    })

    describe('writes', () => {
      test('insertGetId returns a usable key', async () => {
        await truncate()

        const id = await table().insertGetId({ name: 'Ada' })

        expect(id).toBeDefined()
        expect(Number(id)).toBeGreaterThan(0)
        expect(await table().where('id', id).value<string>('name')).toBe('Ada')
      })

      test('a batch insert binds every row', async () => {
        await truncate()

        expect(
          await table().insert([
            { name: 'Ada', votes: 1 },
            { name: 'Linus', votes: 2 },
            { name: 'Grace', votes: 3 }
          ])
        ).toBe(3)
        expect(await table().count()).toBe(3)
      })

      test('multiple bindings survive the dialect placeholder style', async () => {
        await truncate()
        await table().insert([
          { name: 'Ada', votes: 10 },
          { name: 'Linus', votes: 5 }
        ])

        // Postgres numbers placeholders ($1..$n) while the others use `?`; a
        // multi-clause query is where getting that wrong shows up.
        const rows = await table()
          .where('votes', '>', 1)
          .where('name', '!=', 'Grace')
          .whereIn('name', ['Ada', 'Linus'])
          .whereBetween('votes', [1, 100])
          .orderByDesc('votes')
          .get()

        expect(rows.pluck('name').all()).toEqual(['Ada', 'Linus'])
      })

      test('insertOrIgnore swallows the unique violation', async () => {
        await truncate()
        await table().insert({ name: 'Ada', email: 'dup@example.com' })

        expect(await table().insertOrIgnore({ name: 'Other', email: 'dup@example.com' })).toBe(0)
        expect(await table().count()).toBe(1)
      })

      test('upsert inserts then updates on conflict', async () => {
        await truncate()

        await table().upsert({ name: 'Ada', email: 'ada@example.com', votes: 1 }, ['email'])
        await table().upsert({ name: 'Ada Lovelace', email: 'ada@example.com', votes: 9 }, [
          'email'
        ])

        expect(await table().count()).toBe(1)
        expect(await table().where('email', 'ada@example.com').value<string>('name')).toBe(
          'Ada Lovelace'
        )
      })

      test('update and delete report the affected count', async () => {
        await truncate()
        await table().insert([{ name: 'Ada' }, { name: 'Linus' }])

        expect(await table().where('name', 'Ada').update({ votes: 5 })).toBe(1)
        expect(await table().where('name', 'Ada').delete()).toBe(1)
        expect(await table().count()).toBe(1)
      })

      test('increment reads the column rather than binding it', async () => {
        await truncate()
        await table().insert({ name: 'Ada', votes: 1 })

        await table().where('name', 'Ada').increment('votes', 4)

        expect(Number(await table().where('name', 'Ada').value<number>('votes'))).toBe(5)
      })

      test('truncate empties a table nothing references', async () => {
        await truncate()
        const id = await table().insertGetId({ name: 'Ada' })
        await table(posts).insert({ user_id: id, title: 'First' })

        // `posts` is truncated rather than `users`: MySQL refuses to truncate a
        // table that a foreign key points at, however empty the child is.
        await table(posts).truncate()

        expect(await table(posts).count()).toBe(0)
      })
    })

    describe('aggregates', () => {
      test('count, sum, max, min and avg', async () => {
        await truncate()
        await table().insert([
          { name: 'Ada', votes: 10 },
          { name: 'Linus', votes: 5 },
          { name: 'Grace', votes: 20 }
        ])

        expect(await table().count()).toBe(3)
        expect(await table().sum('votes')).toBe(35)
        expect(Number(await table().max<number>('votes'))).toBe(20)
        expect(Number(await table().min<number>('votes'))).toBe(5)
        expect(Number(await table().avg('votes'))).toBeCloseTo(11.666, 2)
      })
    })

    describe('transactions', () => {
      test('a throw rolls every statement back', async () => {
        await truncate()

        /**
         * Caught rather than asserted with `.rejects`.
         *
         * `expect(promise).rejects` never settled on Windows before Bun 1.4 when
         * the promise came from a networked driver: the run hung with no output
         * and Bun blamed a hook whose measured time was 0 ms. 1.4 fixed it, and
         * this stays — catching asserts the same thing and cannot hang on any
         * version. See BEHAVIOURS.
         */
        const refused = await connection
          .transaction(async (tx) => {
            await new QueryBuilder(tx, users).insert({ name: 'Ada' })
            throw new Error('nope')
          })
          .catch((error: unknown) => error)

        expect<string>(String((refused as Error).message)).toBe('nope')

        expect(await table().count()).toBe(0)
      })

      test('a commit persists', async () => {
        await truncate()

        await connection.transaction(async (tx) => {
          await new QueryBuilder(tx, users).insert({ name: 'Ada' })
          await new QueryBuilder(tx, users).insert({ name: 'Linus' })
        })

        expect(await table().count()).toBe(2)
      })

      test('after-commit work waits for the commit', async () => {
        await truncate()

        const ran: string[] = []

        await connection.transaction(async (tx) => {
          await new QueryBuilder(tx, users).insert({ name: 'Ada' })
          // Found in async context, not on `tx`: this is how a queued listener or
          // job defers itself without holding the transaction.
          await connection.afterCommit(() => ran.push('deferred'))

          expect(ran).toEqual([])
        })

        expect(ran).toEqual(['deferred'])
      })

      /**
       * Two transactions at once are **siblings**, not one nested in the other.
       *
       * SQLite is skipped rather than passing vacuously: Bun opens one connection
       * to it, so the second `begin()` fails in the driver — the assertion would
       * hold for the wrong reason.
       *
       * This is also the case a per-connection depth counter gets wrong: it reads
       * the second `begin()` as nested and takes a savepoint on the pool, which is
       * not a transaction at all.
       */
      test.skipIf(name === 'sqlite')(
        'concurrent transactions keep their deferred work apart',
        async () => {
          await truncate()

          const ran: string[] = []

          const [, failed] = await Promise.allSettled([
            connection.transaction(async (tx) => {
              await new QueryBuilder(tx, users).insert({ name: 'Ada' })
              await tx.afterCommit(() => ran.push('committed'))
            }),
            connection.transaction(async (tx) => {
              await tx.afterCommit(() => ran.push('rolled back'))
              throw new Error('nope')
            })
          ])

          expect((failed as PromiseRejectedResult).reason.message).toBe('nope')
          expect(ran).toEqual(['committed'])
          expect(await table().count()).toBe(1)
        }
      )
    })

    describe('foreign keys', () => {
      test('an orphan row is rejected', async () => {
        await truncate()

        const refused = await table(posts)
          .insert({ user_id: 99_999, title: 'Orphan' })
          .catch((error: unknown) => error)

        expect<boolean>(refused instanceof Error).toBe(true)
      })

      test('cascade on delete removes the children', async () => {
        await truncate()
        const id = await table().insertGetId({ name: 'Ada' })
        await table(posts).insert({ user_id: id, title: 'First' })

        await table().where('id', id).delete()

        expect(await table(posts).count()).toBe(0)
      })
    })

    /**
     * SQLite is skipped, and the reason is the feature working as intended: the
     * matrix runs SQLite as `:memory:`, and two connections to `:memory:` are two
     * separate databases — so the "replica" genuinely cannot see the writer's
     * table. A split configuration only means anything against a server.
     */
    test.skipIf(name === 'sqlite')(
      'a read/write pair reaches one real server through two connections',
      async () => {
        // Both halves point at the same server: what is checked here is the routing
        // and the sticky rule against a real engine, not that a replica exists.
        const writer = await BunSqlConnection.make(`${name}-w`, config)
        const reader = await BunSqlConnection.make(`${name}-r`, config)
        const pair = new ReadWriteConnection(writer, reader, true)

        const probe = `${PREFIX}_split`
        const probeSchema = new SchemaBuilder(pair)

        try {
          await probeSchema.dropIfExists(probe)
          await probeSchema.create(probe, (table) => {
            table.id()
            table.string('label')
          })

          await new QueryBuilder(pair, probe).insert({ label: 'written' })

          // Sticky: the read that follows a write must find the row on every engine,
          // because it is sent to the writer rather than to the lagging replica.
          expect((await new QueryBuilder(pair, probe).get()).count()).toBe(1)

          pair.forgetRecordModifications()

          // And once the modifications are forgotten, the reader answers again.
          expect((await new QueryBuilder(pair, probe).get()).count()).toBe(1)
        } finally {
          await probeSchema.dropIfExists(probe)
          await pair.disconnect()
        }
      }
    )

    describe('models', () => {
      beforeAll(() => {
        Model.setConnectionResolver(async () => connection)
        Model.setEventDispatcher(undefined)
      })

      test('create, find, update and delete', async () => {
        await truncate()

        const user = await User.create({ name: 'Ada', votes: 3 })
        expect(Number(user.id)).toBeGreaterThan(0)

        const found = await User.find(user.id)
        expect(found?.name).toBe('Ada')

        await found?.update({ name: 'Grace' })
        expect((await User.find(user.id))?.name).toBe('Grace')

        await found?.delete()
        expect(await User.query().count()).toBe(0)
      })

      test('a polymorphic many-to-many round trips, with its pivot columns', async () => {
        await truncate()

        const user = await User.create({ name: 'Ada' })
        const post = await Post.create({ title: 'Hello', user_id: user.id })
        const tag = await Tag.create({ label: 'maths' })

        await user.labels().attach(tag.id, { note: 'from the user' })
        await post.labels().attach(tag.id)

        // One pivot table, two parent types, and neither sees the other's rows —
        // which is the whole reason the type column is written on attach.
        expect((await user.labels().get()).count()).toBe(1)
        expect((await post.labels().get()).count()).toBe(1)

        const pivot = (await user.labels().get()).all()[0]?.getRelation('pivot') as Pivot

        expect(pivot.attributes.note).toBe('from the user')
        expect(pivot.attributes.taggable_type).toBe(users)
        // withTimestamps writes them on attach, whatever the dialect calls its
        // timestamp type.
        expect(pivot.attributes.created_at).toBeTruthy()

        // The inverse names the *related* type, so this returns the user and not
        // the post.
        expect((await tag.taggedUsers().get()).count()).toBe(1)
      })

      test('latestOfMany picks one row per parent, on every dialect', async () => {
        await truncate()

        const ada = await User.create({ name: 'Ada' })
        const linus = await User.create({ name: 'Linus' })

        for (const [index, title] of ['first', 'second'].entries()) {
          const post = await Post.create({ title, user_id: ada.id })
          await post.update({ created_at: `2026-01-0${index + 1} 00:00:00` } as never)
        }

        const only = await Post.create({ title: 'only', user_id: linus.id })
        await only.update({ created_at: '2026-01-05 00:00:00' } as never)

        expect((await ada.latestArticle().getOne())?.title).toBe('second')

        const loaded = await User.with('latestArticle').orderBy('id').get()

        // The join-a-grouped-subquery shape has to compile the same everywhere,
        // and each parent has to keep its own row.
        expect((loaded.all()[0]?.getRelation('latestArticle') as Post | undefined)?.title).toBe(
          'second'
        )
        expect((loaded.all()[1]?.getRelation('latestArticle') as Post | undefined)?.title).toBe(
          'only'
        )
      })

      test('chunkById and cursorPaginate walk by key on every dialect', async () => {
        await truncate()

        for (const index of [1, 2, 3, 4, 5]) {
          await User.create({ name: `User ${index}` })
        }

        const seen: string[] = []
        await User.query().chunkById(2, (models) => {
          seen.push(...models.map((user) => user.name).all())
        })

        expect(seen).toHaveLength(5)

        const first = await User.query().cursorPaginate(2)
        const second = await User.query().cursorPaginate(2, first.nextCursor)

        // `where key > ?` and a replaced order have to compile the same on all
        // three, which is the sort of thing one dialect quietly disagrees about.
        expect(first.data.count()).toBe(2)
        expect(second.data.first()?.name).toBe('User 3')
      })

      /**
       * Two-phase commit, where the server allows it.
       *
       * Postgres ships with `max_prepared_transactions = 0`, which disables prepared
       * transactions entirely, so this skips there rather than failing: the setting
       * is the operator's to change and it needs a restart. MySQL's XA is on by
       * default, which is where this actually runs.
       */
      test('a transaction spans two connections, or says it cannot', async () => {
        const left = `${PREFIX}_2pc_left`
        const right = `${PREFIX}_2pc_right`

        const application = new Application(process.cwd())
        application.config.set('database.default', 'two-phase-a')
        application.config.set('database.connections', {
          'two-phase-a': config,
          'two-phase-b': config
        })

        const manager = new ConnectionManager(application)

        const setup = await manager.connection('two-phase-a')

        await setup.unprepared(`drop table if exists ${setup.grammar.wrapTable(left)}`)
        await setup.unprepared(`drop table if exists ${setup.grammar.wrapTable(right)}`)
        await setup.unprepared(`create table ${setup.grammar.wrapTable(left)} (v varchar(20))`)
        await setup.unprepared(`create table ${setup.grammar.wrapTable(right)} (v varchar(20))`)

        const count = async (table: string) =>
          Number(
            (
              await setup.select<{ n: number | string }>(
                `select count(*) as n from ${setup.grammar.wrapTable(table)}`
              )
            )[0]?.n ?? 0
          )

        const write = () =>
          manager.transactionAcross(['two-phase-a', 'two-phase-b'], async (connections) => {
            await new QueryBuilder(connections['two-phase-a'] as never, left).insert({ v: 'a' })
            await new QueryBuilder(connections['two-phase-b'] as never, right).insert({ v: 'b' })
          })

        try {
          await write()
        } catch (error) {
          const message = (error as Error).message

          // Two refusals are legitimate: SQLite has no 2PC at all, and a Postgres
          // with prepared transactions disabled cannot do it either.
          if (
            message.includes('two-phase commit') ||
            message.includes('prepared transactions are disabled')
          ) {
            await setup.unprepared(`drop table ${setup.grammar.wrapTable(left)}`)
            await setup.unprepared(`drop table ${setup.grammar.wrapTable(right)}`)
            await manager.disconnectAll()

            return
          }

          throw error
        }

        expect(await count(left)).toBe(1)
        expect(await count(right)).toBe(1)

        // A failure after both have written rolls both back — the window this
        // exists to close.
        const refused = await manager
          .transactionAcross(['two-phase-a', 'two-phase-b'], async (connections) => {
            await new QueryBuilder(connections['two-phase-a'] as never, left).insert({ v: 'no' })
            await new QueryBuilder(connections['two-phase-b'] as never, right).insert({ v: 'no' })

            throw new Error('the caller changed its mind')
          })
          .catch((error: unknown) => error)

        expect<boolean>(String((refused as Error).message).includes('changed its mind')).toBe(true)

        expect(await count(left)).toBe(1)
        expect(await count(right)).toBe(1)

        await setup.unprepared(`drop table ${setup.grammar.wrapTable(left)}`)
        await setup.unprepared(`drop table ${setup.grammar.wrapTable(right)}`)
        await manager.disconnectAll()
      })

      /**
       * Vector search, where the server has pgvector.
       *
       * Skipped elsewhere rather than failing: the extension is the operator's to
       * install, and SQLite and MySQL have no equivalent at all.
       */
      test('vector distance orders and filters, where pgvector exists', async () => {
        if (name !== 'postgres') return

        try {
          await connection.unprepared('create extension if not exists vector')
        } catch {
          return
        }

        const table = `${PREFIX}_vectors`

        await schema.dropIfExists(table)
        await schema.create(table, (blueprint) => {
          blueprint.increments('id')
          blueprint.string('label')
          blueprint.vector('embedding', 3)
        })

        try {
          const rows = new QueryBuilder(connection, table)

          await connection.affectingStatement(
            `insert into ${connection.grammar.wrapTable(table)} (label, embedding) values ($1, $2::vector), ($3, $4::vector), ($5, $6::vector)`,
            ['near', '[1,0,0]', 'middle', '[0.7,0.7,0]', 'far', '[0,0,1]']
          )

          const nearest = await rows.clone().orderByVector('embedding', [1, 0, 0]).limit(2).get()

          // Nearest first, by cosine distance — direction, not magnitude, which is
          // what an embedding carries.
          expect(nearest.all().map((row) => String(row.label))).toEqual(['near', 'middle'])

          const close = await rows
            .clone()
            .whereVectorDistance('embedding', [1, 0, 0], '<', 0.1)
            .get()

          // The threshold half: the nearest row to a nonsense query is still a row,
          // and only a distance can say it was not a match.
          expect(close.all().map((row) => String(row.label))).toEqual(['near'])
        } finally {
          await schema.dropIfExists(table)
        }
      })

      test('a column can be changed on every dialect', async () => {
        const table = `${PREFIX}_change`

        await schema.dropIfExists(table)
        await schema.create(table, (blueprint) => {
          blueprint.increments('id')
          blueprint.string('label', 20).nullable()
          blueprint.integer('score').nullable()
          blueprint.index(['score'])
        })

        await new QueryBuilder(connection, table).insert({ label: 'before', score: 7 })

        await schema.table(table, (blueprint) => {
          blueprint.string('label', 120).nullable(false).default('none').change()
        })

        const rows = (await new QueryBuilder(connection, table).get()).all() as Array<
          Record<string, unknown>
        >

        // The rows survive the change — on SQLite that means the rebuild copied them.
        expect(rows.length).toBe(1)
        expect(String(rows[0]?.label)).toBe('before')

        // The new definition is in force: not-null is refused.
        const refused = await new QueryBuilder(connection, table)
          .insert({ label: null, score: 1 })
          .catch((error: unknown) => error)

        expect<boolean>(refused instanceof Error).toBe(true)

        // And the other columns, and the index, are still there — the part a
        // rebuild is most likely to lose.
        expect(await schema.hasColumn(table, 'score')).toBe(true)
        expect(await schema.hasIndex(table, ['score'])).toBe(true)

        await schema.dropIfExists(table)
      })

      test('hasIndex reads each dialect its own way', async () => {
        // pragma_index_list, information_schema.statistics and pg_indexes — three
        // different places, one answer.
        expect(await schema.hasIndex(users, ['email'])).toBe(false)

        const probe = `${PREFIX}_indexed`
        await schema.dropIfExists(probe)
        await schema.create(probe, (table) => {
          table.id()
          table.string('email')
          table.index(['email'])
        })

        try {
          expect(await schema.hasIndex(probe, ['email'])).toBe(true)
        } finally {
          await schema.dropIfExists(probe)
        }
      })

      test('JSON paths and containment behave the same everywhere', async () => {
        await truncate()

        await User.create({ name: 'Ada', meta: { theme: 'dark', tags: ['a', 'b'] } })
        await User.create({ name: 'Linus', meta: { theme: 'light', tags: ['c'] } })

        // The same three queries against three engines with three JSON dialects:
        // the point of putting this in the matrix at all.
        const dark = await User.query().where('meta->theme', 'dark').get()
        expect(dark.map((user) => user.name).all()).toEqual(['Ada'])

        const tagged = await User.query().whereJsonContains('meta->tags', 'a').get()
        expect(tagged.map((user) => user.name).all()).toEqual(['Ada'])

        const not = await User.query().whereJsonDoesntContain('meta->tags', 'a').get()
        expect(not.map((user) => user.name).all()).toEqual(['Linus'])
      })

      test('whereJsonLength counts array elements on every dialect', async () => {
        await truncate()

        await User.create({ name: 'Ada', meta: { tags: ['a', 'b'] } })
        await User.create({ name: 'Linus', meta: { tags: ['c'] } })
        await User.create({ name: 'Grace', meta: { tags: [] } })

        const many = await User.query().whereJsonLength('meta->tags', '>', 1).get()
        expect(many.map((user) => user.name).all()).toEqual(['Ada'])

        // Two arguments mean equality, as everywhere else in the builder.
        const empty = await User.query().whereJsonLength('meta->tags', 0).get()
        expect(empty.map((user) => user.name).all()).toEqual(['Grace'])
      })

      test('updating a JSON path leaves the rest of the document alone', async () => {
        await truncate()

        const ada = await User.create({
          name: 'Ada',
          meta: { theme: 'dark', tags: ['a'], nested: { keep: true } }
        })

        await User.query()
          .where('id', ada.id)
          .update({ 'meta->theme': 'light', 'meta->tags': ['x', 'y'] })

        const fresh = await User.find(ada.id)
        // Asserted before it is read into, so a row that vanished fails here and
        // names itself rather than throwing "cannot read property of undefined"
        // three lines further down.
        expect(fresh).toBeDefined()

        const meta = (fresh as User).meta as Record<string, unknown>

        // The keys that were written, and — the whole point — the ones that were
        // not. Writing the column would have replaced the document.
        expect(meta.theme).toBe('light')
        expect(meta.tags).toEqual(['x', 'y'])
        expect(meta.nested).toEqual({ keep: true })
      })

      test('two writes to one document both survive', async () => {
        await truncate()

        const ada = await User.create({ name: 'Ada', meta: { a: 1, b: 2 } })

        await User.query().where('id', ada.id).update({ 'meta->a': 9, 'meta->b': 8 })

        const fresh = await User.find(ada.id)

        // `set meta = …, meta = …` is legal SQL in which the second wins, so
        // ungrouped writes would leave `a` at 1.
        expect(fresh?.meta).toEqual({ a: 9, b: 8 })
      })

      test('a nested path is reached, and a missing document is created', async () => {
        await truncate()

        const ada = await User.create({ name: 'Ada', meta: { nested: { deep: 'old' } } })

        await User.query().where('id', ada.id).update({ 'meta->nested->deep': 'new' })

        const fresh = await User.find(ada.id)
        expect(fresh).toBeDefined()

        const meta = (fresh as User).meta as never as { nested: { deep: string } }

        expect(meta.nested.deep).toBe('new')
      })

      test('an encrypted column is searchable through its blind index', async () => {
        await truncate()

        class Member extends Model {
          static override table = users
          static override fillable = ['name', 'secret', 'secret_index']
          static override casts = { secret: 'encrypted' } as never
          static override blindIndexes = { secret: 'secret_index' }
        }

        Member.setConnectionResolver(async () => connection)

        /**
         * A stand-in encrypter, injected the way the encryption provider does.
         *
         * The real HMAC is covered in that package's own tests; what is under
         * test here is the model wiring — that the index is written, kept in
         * step, and searched with the same context the row was written with.
         */
        setAttributeEncrypter({
          encryptString: (value) => `enc:${Buffer.from(value).toString('base64url')}`,
          decryptString: (payload) =>
            Buffer.from(payload.replace(/^enc:/, ''), 'base64url').toString(),
          blindIndex: (value, context) =>
            createHash('sha256').update(`${context}\u0000${value}`).digest('base64url')
        })

        await Member.create({ name: 'Ada', secret: 'ada@example.com' })
        await Member.create({ name: 'Linus', secret: 'linus@example.com' })

        const stored = await table().where('name', 'Ada').first()

        // Encrypted at rest, and the index beside it is not the plaintext either.
        expect(String(stored?.secret)).not.toContain('ada@example.com')
        expect(String(stored?.secret_index)).not.toContain('ada@example.com')

        const found = await Member.query().whereBlind('secret', 'ada@example.com').first()

        // The whole point: `where('secret', …)` can never match a ciphertext,
        // because every write produces different bytes.
        expect(found?.getAttribute('name')).toBe('Ada')
        expect(found?.getAttribute('secret')).toBe('ada@example.com')

        const missing = await Member.query().whereBlind('secret', 'nobody@example.com').first()
        expect(missing ?? null).toBeNull()

        // Changing the value moves the index with it, or the row becomes
        // unfindable by its new address and findable by its old one.
        const ada = found as Member
        ada.setAttribute('secret', 'ada@lovelace.test')
        await ada.save()

        expect(
          (await Member.query().whereBlind('secret', 'ada@lovelace.test').first()) !== null
        ).toBe(true)
        expect(
          (await Member.query().whereBlind('secret', 'ada@example.com').first()) ?? null
        ).toBeNull()
      })

      test('ofMany orders by several columns, and can narrow first', async () => {
        await truncate()

        const ada = await User.create({ name: 'Ada' })

        // Two posts share the top score; the newer one should win the tie.
        await Post.create({ user_id: ada.id, title: 'low', votes: 1, published: true })
        await Post.create({ user_id: ada.id, title: 'tie-old', votes: 9, published: false })
        await Post.create({ user_id: ada.id, title: 'tie-new', votes: 9, published: true })

        class Author extends User {
          best(): unknown {
            return this.ofMany(
              Post as never,
              [
                { column: 'votes', aggregate: 'max' },
                { column: 'id', aggregate: 'max' }
              ],
              { foreignKey: 'user_id' }
            )
          }

          bestPublished(): unknown {
            return this.ofMany(Post as never, [{ column: 'votes', aggregate: 'max' }], {
              foreignKey: 'user_id',
              narrow: (query) => {
                query.where('published', true)
              }
            })
          }
        }

        const author = (await Author.find(ada.id)) as Author

        expect(
          (
            (await (
              author.best() as { getOne(): Promise<Model | undefined> }
            ).getOne()) as never as {
              title: string
            }
          )?.title
        ).toBe('tie-new')

        // Narrowing runs before the aggregate: filtering afterwards would ask a
        // different question, because a row has already been picked by then.
        expect(
          (
            (await (
              author.bestPublished() as { getOne(): Promise<Model | undefined> }
            ).getOne()) as never as { title: string }
          )?.title
        ).toBe('tie-new')
      })

      test('attaching touches the related row when it named the inverse', async () => {
        await truncate()

        const ada = await User.create({ name: 'Ada' })
        const post = await Post.create({ user_id: ada.id, title: 'Tagged' })

        // The inverse is guessed from the parent's class name: Post -> posts.
        Tag.touches = ['posts']
        Tag.timestamps = true

        try {
          const tag = await Tag.create({ label: 'news' })
          const before = (await table(tags).where('id', tag.id).first())?.updated_at

          await Bun.sleep(1100)
          await (post.labels() as never as { attach(id: unknown): Promise<void> }).attach(tag.id)

          const after = (await table(tags).where('id', tag.id).first())?.updated_at

          // A cache keyed on the tag's timestamp has to expire when its
          // membership changes, and only the tag's own row can say so.
          expect(String(after)).not.toBe(String(before))
        } finally {
          Tag.touches = []
          Tag.timestamps = false
        }
      })

      test('morphToManyThrough reaches a pivot two hops away', async () => {
        await truncate()

        const ada = await User.create({ name: 'Ada' })
        const post = await Post.create({ user_id: ada.id, title: 'Post' })

        const news = await Tag.create({ label: 'news' })
        const draft = await Tag.create({ label: 'draft' })

        // Two posts by the same author, sharing a tag: the duplicate is what the
        // relation has to collapse.
        const second = await Post.create({ user_id: ada.id, title: 'Second' })

        await table(taggables).insert([
          { tag_id: news.id, taggable_id: post.id, taggable_type: Post.getMorphClass() },
          { tag_id: news.id, taggable_id: second.id, taggable_type: Post.getMorphClass() },
          { tag_id: draft.id, taggable_id: post.id, taggable_type: Post.getMorphClass() }
        ])

        class Author extends User {
          static override table = users

          postTags() {
            return this.morphToManyThrough(
              Tag as never,
              Post as never,
              'taggable',
              taggables,
              'user_id',
              'tag_id'
            )
          }
        }

        const author = (await Author.find(ada.id)) as Author
        const tags = await (
          author.postTags() as never as { get(): Promise<{ all(): Array<{ label: string }> }> }
        ).get()

        // Every tag used on this author's posts, once each.
        expect(
          tags
            .all()
            .map((tag) => tag.label)
            .sort()
        ).toEqual(['draft', 'news'])
      })

      test('boolean and json casts survive the round trip', async () => {
        await truncate()

        await User.create({ name: 'Ada', active: false, meta: { theme: 'dark' } })
        const user = await User.first()

        // Each driver returns a different raw shape here: 0, false, or Buffer.
        expect(user?.active).toBe(false)
        expect(user?.meta).toEqual({ theme: 'dark' })
      })

      test('saving a clean model issues no update', async () => {
        await truncate()
        const user = await User.create({ name: 'Ada' })
        const before = user.attributes.updated_at

        await user.save()

        expect(user.attributes.updated_at).toBe(before)
      })

      test('relations and eager loading', async () => {
        await truncate()

        const ada = await User.create({ name: 'Ada' })
        const linus = await User.create({ name: 'Linus' })
        await ada.articles().create({ title: 'A1' })
        await ada.articles().create({ title: 'A2' })
        await linus.articles().create({ title: 'L1' })

        expect((await ada.articles().get()).count()).toBe(2)

        const loaded = await User.with('articles').orderBy('id').get()
        const counts = loaded
          .all()
          .map((user) => (user.getRelation('articles') as { count(): number }).count())

        expect(counts).toEqual([2, 1])

        const post = await Post.first()
        expect((await post?.author().get())?.name).toBeDefined()
      })

      test('paginate reports totals', async () => {
        await truncate()
        await User.create({ name: 'Ada' })
        await User.create({ name: 'Linus' })
        await User.create({ name: 'Grace' })

        const page = await User.query().orderBy('id').paginate(2, 2)

        expect(page.total).toBe(3)
        expect(page.data.count()).toBe(1)
      })
    })

    describe('migrator', () => {
      let directory: string

      beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'elvel-dialect-'))

        await Bun.write(
          join(directory, '2026_01_01_000000_create_widgets_table.ts'),
          // A `file://` URL, because a Windows path written into a quoted string
          // turns `\S` and `\e` into escape sequences and loses every separator.
          `import { Migration } from '${pathToFileURL(join(import.meta.dir, '..', 'src', 'migrations/migration.ts')).href}'

           export default class extends Migration {
             async up({ schema }) {
               await schema.create('${PREFIX}_widgets', (t) => {
                 t.id()
                 t.string('label')
                 t.boolean('active').default(true)
                 t.timestamps()
               })
             }

             async down({ schema }) {
               await schema.dropIfExists('${PREFIX}_widgets')
             }
           }
          `
        )
      })

      afterAll(async () => {
        await schema.dropIfExists(`${PREFIX}_widgets`)
        await schema.dropIfExists(`${PREFIX}_migrations`)
        await rm(directory, { recursive: true, force: true })
      })

      test('migrate then rollback, against the real server', async () => {
        const repository = new MigrationRepository(connection, `${PREFIX}_migrations`)
        const migrator = new Migrator(connection, repository, [directory])

        const applied = await migrator.run()
        expect(applied).toEqual(['2026_01_01_000000_create_widgets_table'])
        expect(await schema.hasTable(`${PREFIX}_widgets`)).toBe(true)

        // The tracking table is created by our own schema builder, so this also
        // exercises increments() on this dialect.
        expect(await repository.getRan()).toHaveLength(1)

        const reverted = await migrator.rollback()
        expect(reverted).toEqual(['2026_01_01_000000_create_widgets_table'])
        expect(await schema.hasTable(`${PREFIX}_widgets`)).toBe(false)
      })
    })
  })
}
