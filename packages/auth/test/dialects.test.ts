import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BunSqlConnection,
  type ConnectionConfig,
  QueryBuilder,
  SchemaBuilder
} from '@elvel/database'
import { betterAuth } from 'better-auth'
import { twoFactor } from 'better-auth/plugins'
import { reachable } from '../../../tests/support/dialects.ts'
import {
  type Dialect,
  diffMigrationFor,
  elvelAdapter,
  migrationFor,
  schemaShape
} from '../src/adapter.ts'

/** What a generated migration is, as a module. */
type MigrationClass = new () => {
  up(context: unknown): Promise<void>
  down(context: unknown): Promise<void>
}

/**
 * Write generated source to disk and import it, which is what `migrate` does.
 *
 * Inside the repository rather than `os.tmpdir()`: the file imports
 * `@elvel/database`, and a directory outside the workspace cannot resolve that.
 * A string that merely contains the right words is no evidence that it parses.
 */
async function write(code: string): Promise<{
  directory: string
  instance: InstanceType<MigrationClass>
}> {
  const directory = await mkdtemp(join(import.meta.dir, '.generated-'))
  const file = join(directory, 'migration.ts')

  await writeFile(file, code)

  const Generated = ((await import(pathToFileURL(file).href)) as { default: MigrationClass })
    .default

  return { directory, instance: new Generated() }
}

/**
 * The adapter against real servers.
 *
 * The unit suite drives it on sqlite, where nearly everything is text and
 * forgiving. What the other dialects settle is exactly what a plausible-looking
 * config gets wrong: Postgres has a real `boolean` column and rejects `1` for
 * it, MySQL's `timestamp` rejects the `T` and `Z` of an ISO string, and neither
 * accepts a JavaScript `Date` as a bound parameter the way sqlite shrugs at it.
 *
 * A server that is unreachable drops out with a note rather than failing, so the
 * suite stays green without one. Override with TEST_POSTGRES_URL/TEST_MYSQL_URL.
 */

type Candidate = { name: Dialect; config: ConnectionConfig }

const PREFIX = `auth_t${Date.now().toString(36)}`

// `name` is a `Dialect` here rather than a string, because the adapter takes one;
// the shared matrix hands back the same three names.
const available = (await reachable('auth')).map((candidate) => ({
  ...candidate,
  name: candidate.name as Dialect
})) satisfies Candidate[]

test('sqlite is always part of the matrix', () => {
  expect(available.map((candidate) => candidate.name)).toContain('sqlite')
})

for (const { name, config } of available) {
  describe(`auth on ${name}`, () => {
    // One connection for the whole block: sqlite's `:memory:` database exists
    // only as long as its connection does.
    let connection: BunSqlConnection

    const tables = {
      user: `${PREFIX}_user`,
      session: `${PREFIX}_session`,
      account: `${PREFIX}_account`,
      verification: `${PREFIX}_verification`
    }

    const table = (model: string) => new QueryBuilder(connection, model)

    /**
     * The schema, generated rather than written out here.
     *
     * It *was* written out, and better-auth 1.7 added `account.issuer` and a
     * unique `(issuer, accountId)` index underneath it — so every test in this
     * block failed on a fixture that described a schema the library had stopped
     * using. Worse than the failure: a fixture agreeing with the wrong schema is
     * how this suite once passed while `auth:schema` emitted a migration MySQL
     * refused to run.
     *
     * So the tables come from `migrationFor`, executed. What the dialects are
     * really being asked here is whether the migration an application would run
     * works on them.
     */
    const setUp = async (db: never) => {
      connection = await BunSqlConnection.make(`auth-${name}`, config)

      const reported = await (
        makeAuth(db) as unknown as { $context: Promise<{ tables: never }> }
      ).$context.then((context) => context.tables)

      const { directory, instance } = await write(migrationFor(reported, name))

      try {
        await instance.up({ schema: new SchemaBuilder(connection), connection })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }

    const tearDown = async () => {
      const schema = new SchemaBuilder(connection)

      for (const model of [tables.account, tables.session, tables.verification, tables.user]) {
        await schema.dropIfExists(model)
      }

      await connection.disconnect()
    }

    /** One description of this run's auth, for the schema and for the test. */
    const makeAuth = (db: never) =>
      betterAuth({
        secret: 'a-test-secret-of-at-least-32-characters',
        baseURL: 'http://localhost',
        emailAndPassword: { enabled: true },
        // The model names are per-run so two dialects never share a table.
        user: { modelName: tables.user },
        session: { modelName: tables.session },
        account: { modelName: tables.account },
        verification: { modelName: tables.verification },
        database: elvelAdapter(db, { dialect: name })
      })

    test('a user signs up, signs in and is read back with the right types', async () => {
      const db = {
        connection: async () => connection,
        table: async (model: string) => new QueryBuilder(connection, model)
      } as never

      await setUp(db)

      try {
        const auth = makeAuth(db)

        const { user } = await auth.api.signUpEmail({
          body: { name: 'Ada', email: 'ada@example.com', password: 'secret123' }
        })

        // A date reached a real `timestamp` column and came back as a Date.
        expect(user.createdAt).toBeInstanceOf(Date)
        // The boolean survived whichever representation the dialect uses.
        expect(user.emailVerified).toBe(false)

        const signedIn = await auth.api.signInEmail({
          body: { email: 'ada@example.com', password: 'secret123' },
          asResponse: true
        })
        const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

        const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
        expect(session?.user.email).toBe('ada@example.com')
        expect(session?.session.expiresAt).toBeInstanceOf(Date)

        // The rows are ours, on this connection, readable with the query builder.
        expect(await table(tables.user).count()).toBe(1)
        expect(await table(tables.account).count()).toBe(1)
        expect(await table(tables.session).count()).toBeGreaterThanOrEqual(1)

        // Writing the boolean the other way round has to work too: Postgres
        // would reject a `1` here, and MySQL would store `true` as 1.
        const verified = await auth.api.getSession({ headers: new Headers({ cookie }) })
        expect(verified?.user.emailVerified).toBe(false)

        /**
         * The unique index the schema builder wrote is enforced by the server.
         *
         * Caught rather than asserted with `.rejects`, which never settles on
         * Windows when the promise came from a networked driver — and this one
         * runs against Postgres and MySQL. See BEHAVIOURS.
         */
        const duplicate = await auth.api
          .signUpEmail({
            body: { name: 'Ada again', email: 'ada@example.com', password: 'secret123' }
          })
          .then(() => null)
          .catch((error: unknown) => error)

        expect<boolean>(duplicate !== null).toBe(true)

        // Signing out deletes exactly one row — its own — through the singular
        // `delete` path, which resolves the key first for that reason. Signing up
        // already opened a session, so the other one has to survive.
        const before = await table(tables.session).count()
        await auth.api.signOut({ headers: new Headers({ cookie }) })

        expect(await table(tables.session).count()).toBe(before - 1)
        expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull()
      } finally {
        await tearDown()
      }
    })

    /**
     * The compound unique index, enforced by the database rather than described.
     *
     * better-auth 1.7 scopes an account's identity to `(issuer, accountId)` and
     * declares it as a table-level `indexes` entry — a shape `migrationFor` had
     * never read, because it only ever walked `table.fields`. So the generated
     * migration ran clean on all three dialects while quietly allowing the same
     * `accountId` from two issuers to collide, which is the exact thing that
     * change exists to prevent.
     *
     * Asserting the index *exists* would have to ask each dialect a different
     * question, so this asks the only question that matters: insert the pair
     * twice and expect the database to refuse it.
     */
    test('the generated schema refuses two accounts with one identity', async () => {
      const db = {
        connection: async () => connection,
        table: async (model: string) => new QueryBuilder(connection, model)
      } as never

      await setUp(db)

      try {
        /**
         * A timestamp each dialect accepts as a bound parameter.
         *
         * The adapter hands better-auth's ISO string straight to Postgres and
         * sqlite and rewrites it for MySQL, which rejects the `T` and the `Z`.
         * These rows go in underneath the adapter, so they have to do the same —
         * and a `Date` object is not bindable at all.
         */
        const now =
          name === 'mysql' || name === 'mariadb'
            ? new Date().toISOString().slice(0, 19).replace('T', ' ')
            : new Date().toISOString()

        await table(tables.user).insert({
          id: 'u1',
          name: 'Ada',
          email: 'ada@example.com',
          emailVerified: false,
          createdAt: now,
          updatedAt: now
        })

        const account = (id: string) => ({
          id,
          issuer: 'credential',
          accountId: 'ada@example.com',
          providerId: 'credential',
          userId: 'u1',
          createdAt: now,
          updatedAt: now
        })

        await table(tables.account).insert(account('a1'))

        // The same identity again. Whatever each dialect calls it, it is a refusal.
        expect(table(tables.account).insert(account('a2'))).rejects.toThrow()

        expect(await table(tables.account).count()).toBe(1)
      } finally {
        await tearDown()
      }
    })

    /**
     * A plugin's schema, on a real server.
     *
     * Everything above covers the four core tables. A plugin adds two shapes
     * neither of them exercises: a **table of its own**, and — the interesting
     * one — **a column on a table better-auth already owns**. `twoFactor` adds
     * `twoFactorEnabled` to `user`, so the generated migration has to alter a
     * table it also creates, and every dialect has its own opinion about
     * booleans and about adding a column.
     *
     * `config/auth.ts` passes `plugins` straight through to `betterAuth`, so an
     * application gets this by writing two lines — which makes it worth knowing
     * that the schema it generates actually runs, rather than only that it can
     * be generated.
     */
    test('a plugin brings its own tables and columns, and they run', async () => {
      connection = await BunSqlConnection.make(`auth-plugin-${name}`, config)

      const prefixed = (model: string) => `${PREFIX}_plugin_${model}`

      const db = {
        connection: async () => connection,
        schema: async () => new SchemaBuilder(connection)
      }

      const auth = betterAuth({
        secret: 'a-very-long-test-secret-value-000000',
        baseURL: 'http://localhost',
        emailAndPassword: { enabled: true },
        /**
         * The plugin's table is renamed too.
         *
         * Left alone it is called `twoFactor`, unprefixed — fine in an
         * application, and a collision here, because Postgres and MySQL are
         * shared between runs while sqlite's `:memory:` is not.
         */
        plugins: [twoFactor({ schema: { twoFactor: { modelName: prefixed('twoFactor') } } })],
        user: { modelName: prefixed('user') },
        session: { modelName: prefixed('session') },
        account: { modelName: prefixed('account') },
        verification: { modelName: prefixed('verification') },
        database: elvelAdapter(db as never, { dialect: name })
      })

      const schema = new SchemaBuilder(connection)

      /** The schema better-auth reports — the same thing `auth:schema` reads. */
      const tables = await (
        auth as unknown as { $context: Promise<{ tables: never }> }
      ).$context.then((context) => context.tables)

      try {
        const shape = schemaShape(tables)

        // Four core tables plus the plugin's own.
        expect(shape.length).toBe(5)

        const twoFactorTable = shape.find((entry) => /twoFactor/i.test(entry.table))
        const userTable = shape.find((entry) => entry.table === prefixed('user'))

        // The plugin's own table…
        expect(twoFactorTable).toBeDefined()
        expect(twoFactorTable?.columns).toContain('secret')

        // …and the column it puts on a table it does not own.
        expect(userTable?.columns).toContain('twoFactorEnabled')

        // The migration our grammar renders for this dialect, which is the part
        // that has never been checked against a server before.
        const migration = migrationFor(tables, name)

        expect(migration).toContain('twoFactorEnabled')
        expect(migration).toContain(prefixed('twoFactor'))

        /**
         * Run the migration itself, not a hand-built approximation of it.
         *
         * Rendering proves the generator; **executing** proves the dialect accepts
         * what was rendered, which is a different question and the one Postgres
         * and MySQL answer differently from sqlite. Building the tables by hand
         * here would have quietly tested a schema nobody ships — the plugin's
         * `failedVerificationCount` is rendered as `integer`, and a hand-written
         * `text` would have passed while the real column failed.
         *
         * Written to a file and imported because that is what `migrate` does with
         * it: a migration is a module with `up` and `down`, and a string that
         * merely contains the right words is no evidence that it parses.
         */
        /**
         * Inside the repository, not in `os.tmpdir()`.
         *
         * The generated migration imports `@elvel/database` — as a real one in an
         * application does — and a directory outside the workspace cannot resolve
         * that. Writing it where module resolution is the real thing is the
         * difference between testing the migration and testing a string.
         */
        const directory = await mkdtemp(join(import.meta.dir, '.generated-'))
        const file = join(directory, 'migration.ts')

        await writeFile(file, migration)

        const Generated = ((await import(pathToFileURL(file).href)) as { default: MigrationClass })
          .default

        const instance = new Generated()
        let ran = false

        try {
          await instance.up({ schema } as never)
          ran = true

          /**
           * Written through better-auth, not through the query builder.
           *
           * A raw `insert` would bypass the adapter, which is the thing that
           * converts a `Date` and a boolean for each dialect — and it shows: the
           * first version of this test handed sqlite a `Date` and got
           * `Binding expected string, TypedArray, boolean, number, bigint or
           * null`. Signing up exercises the path an application actually uses,
           * against a schema a plugin extended.
           */
          const signedUp = await auth.api.signUpEmail({
            body: { name: 'Ada', email: 'ada@example.com', password: 'secret123' }
          })

          expect(signedUp).toBeTruthy()

          const row = await new QueryBuilder(connection, prefixed('user'))
            .where('email', 'ada@example.com')
            .first()

          expect(row).toBeTruthy()

          // The column the plugin added to a table it does not own, written by
          // better-auth's own default and read back through our grammar.
          expect(Boolean(row?.twoFactorEnabled)).toBe(false)

          // And the plugin's own table exists, with the column it needs.
          expect(await schema.hasTable(prefixed('twoFactor'))).toBe(true)
          expect(await schema.hasColumn(prefixed('twoFactor'), 'secret')).toBe(true)
        } finally {
          // `down()` is the other half of what makes a generated migration
          // deployable, so it is exercised rather than assumed.
          if (ran) await instance.down({ schema } as never)

          await rm(directory, { recursive: true, force: true })
        }
      } finally {
        await connection.disconnect()
      }
    })

    /**
     * `auth:schema --diff`, which is what adding a plugin to a *running*
     * application actually does.
     *
     * The full migration would try to create a `user` table that already holds
     * users, so the diff writes `schema.table(...)` instead — a column added to a
     * table better-auth already owns, and dropped again on the way down. Neither
     * half had ever been executed anywhere: `diffMigrationFor` had no test at
     * all, and it is the path the documentation tells people to use.
     *
     * Adding and dropping a column is also where dialects differ most: sqlite
     * only learned `drop column` recently, MySQL rewrites the table, and Postgres
     * does it in a transaction.
     */
    test('a diff adds a plugin column to a live table, and takes it back', async () => {
      connection = await BunSqlConnection.make(`auth-diff-${name}`, config)

      const prefixed = (model: string) => `${PREFIX}_diff_${model}`
      const schema = new SchemaBuilder(connection)
      const db = {
        connection: async () => connection,
        schema: async () => schema
      }

      /** The same application, before and after the plugin is added. */
      const build = (plugins: unknown[]) =>
        betterAuth({
          secret: 'a-very-long-test-secret-value-000000',
          baseURL: 'http://localhost',
          emailAndPassword: { enabled: true },
          plugins: plugins as never,
          user: { modelName: prefixed('user') },
          session: { modelName: prefixed('session') },
          account: { modelName: prefixed('account') },
          verification: { modelName: prefixed('verification') },
          database: elvelAdapter(db as never, { dialect: name })
        })

      const tablesOf = (auth: unknown) =>
        (auth as { $context: Promise<{ tables: never }> }).$context.then(
          (context) => context.tables
        )

      const before = await tablesOf(build([]))
      const after = await tablesOf(
        build([twoFactor({ schema: { twoFactor: { modelName: prefixed('twoFactor') } } })])
      )

      const created: string[] = []
      let applied = false

      try {
        // Install the application as it was, without the plugin.
        const initial = await write(migrationFor(before, name))

        await initial.instance.up({ schema } as never)
        applied = true
        for (const entry of schemaShape(before)) created.push(entry.table)
        await rm(initial.directory, { recursive: true, force: true })

        // Now ask what is missing, exactly as the command does.
        const existing = new Map<string, string[]>()

        for (const { table } of schemaShape(after)) {
          if (!(await schema.hasTable(table))) continue

          existing.set(table.toLowerCase(), await schema.getColumnListing(table))
        }

        const diff = diffMigrationFor(after, name, existing)

        expect(diff).toBeDefined()

        // The plugin's table is missing entirely; `user` is missing one column.
        expect(diff?.code).toContain(`schema.table('${prefixed('user')}'`)
        expect(diff?.code).toContain('twoFactorEnabled')
        expect(diff?.code).toContain(`schema.create('${prefixed('twoFactor')}'`)

        const patch = await write(diff?.code ?? '')

        try {
          await patch.instance.up({ schema } as never)

          expect(await schema.hasColumn(prefixed('user'), 'twoFactorEnabled')).toBe(true)
          expect(await schema.hasTable(prefixed('twoFactor'))).toBe(true)

          // And back down: the column goes, the users stay.
          await patch.instance.down({ schema } as never)

          expect(await schema.hasColumn(prefixed('user'), 'twoFactorEnabled')).toBe(false)
          expect(await schema.hasTable(prefixed('user'))).toBe(true)
        } finally {
          await rm(patch.directory, { recursive: true, force: true })
        }

        // Nothing left to do is reported as nothing, not as an empty migration.
        const settled = new Map<string, string[]>()

        for (const { table } of schemaShape(before)) {
          if (!(await schema.hasTable(table))) continue

          settled.set(table.toLowerCase(), await schema.getColumnListing(table))
        }

        expect(diffMigrationFor(before, name, settled)).toBeUndefined()
      } finally {
        if (applied) {
          for (const model of created.reverse()) await schema.dropIfExists(model)
          await schema.dropIfExists(prefixed('twoFactor'))
        }

        await connection.disconnect()
      }
    })
  })
}
