import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { QueryBuilder } from '../src/query/builder.ts'
import { raw } from '../src/query/expression.ts'
import { Blueprint } from '../src/schema/blueprint.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'
import { MySqlSchemaGrammar } from '../src/schema/grammars/mysql.ts'
import { PostgresSchemaGrammar } from '../src/schema/grammars/postgres.ts'
import { SQLiteSchemaGrammar } from '../src/schema/grammars/sqlite.ts'

const sqlite = new SQLiteSchemaGrammar()
const mysql = new MySqlSchemaGrammar()
const postgres = new PostgresSchemaGrammar()

function blueprint(callback: (table: Blueprint) => void, table = 'users'): Blueprint {
  const instance = new Blueprint(table).create()
  callback(instance)

  return instance
}

describe('auto-incrementing keys differ sharply per dialect', () => {
  const plan = blueprint((table) => {
    table.id()
  })

  test('sqlite collapses every integer width and inlines the key', () => {
    expect(sqlite.compile(plan)).toEqual([
      'create table "users" ("id" integer primary key autoincrement not null)'
    ])
  })

  test('mysql keeps bigint and appends auto_increment', () => {
    expect(mysql.compile(plan)).toEqual([
      'create table `users` (`id` bigint unsigned not null auto_increment primary key)'
    ])
  })

  test('postgres expresses it through the type', () => {
    expect(postgres.compile(plan)).toEqual([
      'create table "users" ("id" bigserial not null primary key)'
    ])
  })
})

describe('modifier order', () => {
  test('sqlite puts increment before not null, which SQL requires', () => {
    const sql = sqlite.compile(plan_increments())[0] as string

    expect(sql.indexOf('primary key autoincrement')).toBeLessThan(sql.indexOf('not null'))
  })

  test('mysql puts unsigned before nullability and increment last', () => {
    const sql = mysql.compile(plan_increments())[0] as string

    expect(sql.indexOf('unsigned')).toBeLessThan(sql.indexOf('not null'))
    expect(sql.indexOf('not null')).toBeLessThan(sql.indexOf('auto_increment'))
  })

  function plan_increments() {
    return blueprint((table) => {
      table.id()
    })
  }
})

describe('column types and modifiers', () => {
  test('strings carry their length where the dialect supports it', () => {
    const plan = blueprint((table) => {
      table.string('name')
      table.string('code', 10)
    })

    expect(mysql.compile(plan)[0]).toContain('`name` varchar(255) not null')
    expect(mysql.compile(plan)[0]).toContain('`code` varchar(10) not null')
    // SQLite ignores the length entirely.
    expect(sqlite.compile(plan)[0]).toContain('"name" varchar not null')
  })

  test('nullable is explicit everywhere except sqlite', () => {
    const plan = blueprint((table) => {
      table.string('nickname').nullable()
    })

    // SQLite omits an explicit `null`: no `not null` is what makes it nullable.
    expect(sqlite.compile(plan)[0]).toBe('create table "users" ("nickname" varchar)')
    expect(mysql.compile(plan)[0]).toContain('`nickname` varchar(255) null')
    expect(postgres.compile(plan)[0]).toContain('"nickname" varchar(255) null')
  })

  test('defaults are quoted by type, and raw defaults pass through', () => {
    const plan = blueprint((table) => {
      table.string('role').default('member')
      table.integer('votes').default(0)
      table.boolean('active').default(true)
      table.string('slug').default(raw('(lower(hex(randomblob(4))))'))
    })

    const sql = sqlite.compile(plan)[0] as string

    expect(sql).toContain("default 'member'")
    expect(sql).toContain('default 0')
    expect(sql).toContain('default 1')
    expect(sql).toContain('default (lower(hex(randomblob(4))))')
  })

  test('a quote inside a default is escaped, not injected', () => {
    const plan = blueprint((table) => {
      table.string('note').default("it's fine")
    })

    expect(sqlite.compile(plan)[0]).toContain("default 'it''s fine'")
  })

  test('timestamps and softDeletes expand to nullable columns', () => {
    const plan = blueprint((table) => {
      table.timestamps()
      table.softDeletes()
    })

    const sql = sqlite.compile(plan)[0] as string

    expect(sql).toContain('"created_at" datetime')
    expect(sql).toContain('"updated_at" datetime')
    expect(sql).toContain('"deleted_at" datetime')
    expect(sql).not.toContain('created_at" datetime not null')
  })

  test('useCurrent and useCurrentOnUpdate', () => {
    const plan = blueprint((table) => {
      table.timestamp('created_at').useCurrent()
      table.timestamp('updated_at').useCurrent().useCurrentOnUpdate()
    })

    const sql = mysql.compile(plan)[0] as string

    expect(sql).toContain('`created_at` timestamp not null default current_timestamp')
    expect(sql).toContain('on update current_timestamp')
  })

  test('enum becomes a native type on mysql and a check on postgres', () => {
    const plan = blueprint((table) => {
      table.enum('status', ['draft', 'live'])
    })

    expect(mysql.compile(plan)[0]).toContain("enum('draft', 'live')")
    expect(postgres.compile(plan)[0]).toContain("check (\"status\" in ('draft', 'live'))")
  })

  test('unsigned is honoured by mysql and ignored by postgres', () => {
    const plan = blueprint((table) => {
      table.unsignedBigInteger('user_id')
    })

    expect(mysql.compile(plan)[0]).toContain('`user_id` bigint unsigned')
    expect(postgres.compile(plan)[0]).toContain('"user_id" bigint not null')
  })

  test('comment, after and first only exist on mysql', () => {
    const plan = blueprint((table) => {
      table.string('name').comment('display name').after('id')
    })

    expect(mysql.compile(plan)[0]).toContain("comment 'display name' after `id`")
    expect(sqlite.compile(plan)[0]).not.toContain('comment')
  })
})

describe('indexes and keys', () => {
  test('indexes are separate statements with generated names', () => {
    const statements = sqlite.compile(
      blueprint((table) => {
        table.id()
        table.string('email').unique()
        table.string('city')
        table.index(['city'])
      })
    )

    expect(statements).toHaveLength(3)
    expect(statements[1]).toBe('create unique index "users_email_unique" on "users" ("email")')
    expect(statements[2]).toBe('create index "users_city_index" on "users" ("city")')
  })

  test('a composite primary key is inlined when there is no auto-increment', () => {
    const statements = sqlite.compile(
      blueprint((table) => {
        table.unsignedBigInteger('post_id')
        table.unsignedBigInteger('tag_id')
        table.primary(['post_id', 'tag_id'])
      }, 'post_tag')
    )

    expect(statements[0]).toContain('primary key ("post_id", "tag_id")')
  })

  test('an auto-increment column suppresses a duplicate primary key clause', () => {
    const statements = sqlite.compile(
      blueprint((table) => {
        table.id()
        table.primary(['id'])
      })
    )

    expect(statements[0]).toBe(
      'create table "users" ("id" integer primary key autoincrement not null)'
    )
  })

  test('foreign keys are inlined on create and altered in later', () => {
    const created = sqlite.compile(
      blueprint((table) => {
        table.id()
        table.foreignId('user_id').constrained('users').cascadeOnDelete()
      }, 'posts')
    )

    expect(created[0]).toContain(
      'constraint "posts_user_id_foreign" foreign key ("user_id") references "users" ("id") on delete cascade'
    )

    const altered = new Blueprint('posts')
    altered.foreign(['author_id']).references(['id']).on('users').nullOnDelete()

    expect(mysql.compile(altered)[0]).toBe(
      'alter table `posts` add constraint `posts_author_id_foreign` foreign key (`author_id`) references `users` (`id`) on delete set null'
    )
  })

  test('constrained infers the table from the column name', () => {
    const statements = sqlite.compile(
      blueprint((table) => {
        table.foreignId('user_id').constrained()
      }, 'posts')
    )

    expect(statements[0]).toContain('references "users" ("id")')
  })

  test('morphs adds both columns and an index', () => {
    const statements = sqlite.compile(
      blueprint((table) => {
        table.morphs('taggable')
      }, 'tags')
    )

    expect(statements[0]).toContain('"taggable_type" varchar not null')
    expect(statements[0]).toContain('"taggable_id" integer not null')
    expect(statements[1]).toBe(
      'create index "tags_taggable_type_taggable_id_index" on "tags" ("taggable_type", "taggable_id")'
    )
  })
})

describe('altering tables', () => {
  test('adding columns becomes one alter per column', () => {
    const plan = new Blueprint('users')
    plan.string('phone').nullable()
    plan.boolean('verified').default(false)

    expect(sqlite.compile(plan)).toEqual([
      'alter table "users" add column "phone" varchar',
      'alter table "users" add column "verified" tinyint(1) not null default 0'
    ])
  })

  test('dropping columns, indexes and renaming', () => {
    const dropped = new Blueprint('users')
    dropped.dropColumn('phone', 'verified')

    expect(sqlite.compile(dropped)).toEqual([
      'alter table "users" drop column "phone"',
      'alter table "users" drop column "verified"'
    ])

    const index = new Blueprint('users')
    index.dropUnique(['email'])
    expect(sqlite.compile(index)).toEqual(['drop index "users_email_unique"'])
    expect(mysql.compile(index)).toEqual(['alter table `users` drop index `users_email_unique`'])

    const renamed = new Blueprint('users')
    renamed.renameColumn('name', 'full_name')
    expect(sqlite.compile(renamed)).toEqual([
      'alter table "users" rename column "name" to "full_name"'
    ])
  })

  test('sqlite refuses to drop constraints instead of emitting broken SQL', () => {
    const plan = new Blueprint('posts')
    plan.dropForeign(['user_id'])

    expect(() => sqlite.compile(plan)).toThrow(/recreate the table/)
  })

  test('drop and dropIfExists', () => {
    const drop = new Blueprint('users')
    drop.drop()
    expect(sqlite.compile(drop)).toEqual(['drop table "users"'])

    const ifExists = new Blueprint('users')
    ifExists.dropIfExists()
    expect(sqlite.compile(ifExists)).toEqual(['drop table if exists "users"'])
  })

  test('rename', () => {
    const plan = new Blueprint('users')
    plan.rename('people')

    expect(sqlite.compile(plan)).toEqual(['alter table "users" rename to "people"'])
  })
})

describe('SchemaBuilder against a real database', () => {
  let connection: BunSqlConnection
  let schema: SchemaBuilder

  beforeEach(async () => {
    connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
    schema = new SchemaBuilder(connection)
  })

  afterEach(async () => {
    await connection.disconnect()
  })

  test('creates a table that actually accepts rows', async () => {
    await schema.create('users', (table) => {
      table.id()
      table.string('name')
      table.string('email').unique()
      table.boolean('active').default(true)
      table.timestamps()
    })

    const users = new QueryBuilder(connection, 'users')
    const id = await users.insertGetId({ name: 'Ada', email: 'ada@example.com' })

    expect(id).toBe(1)
    expect(await users.where('email', 'ada@example.com').value<number>('active')).toBe(1)
  })

  test('the unique index it created is enforced', async () => {
    await schema.create('users', (table) => {
      table.id()
      table.string('email').unique()
    })

    const users = new QueryBuilder(connection, 'users')
    await users.insert({ email: 'dup@example.com' })

    await expect(users.insert({ email: 'dup@example.com' })).rejects.toThrow()
  })

  test('hasTable and hasColumn read the real schema', async () => {
    expect(await schema.hasTable('users')).toBe(false)

    await schema.create('users', (table) => {
      table.id()
      table.string('name')
    })

    expect(await schema.hasTable('users')).toBe(true)
    expect(await schema.hasColumn('users', 'name')).toBe(true)
    expect(await schema.hasColumn('users', 'nope')).toBe(false)
    expect(await schema.getColumnListing('users')).toEqual(['id', 'name'])
  })

  test('adding a column later works on a populated table', async () => {
    await schema.create('users', (table) => {
      table.id()
      table.string('name')
    })
    await new QueryBuilder(connection, 'users').insert({ name: 'Ada' })

    await schema.table('users', (table) => {
      table.string('nickname').nullable()
    })

    expect(await schema.hasColumn('users', 'nickname')).toBe(true)
    expect(await new QueryBuilder(connection, 'users').count()).toBe(1)
  })

  test('drop, dropIfExists and rename', async () => {
    await schema.create('users', (table) => {
      table.id()
    })

    await schema.rename('users', 'people')
    expect(await schema.hasTable('people')).toBe(true)

    await schema.drop('people')
    expect(await schema.hasTable('people')).toBe(false)

    // Dropping something absent must not throw when guarded.
    await schema.dropIfExists('people')
  })

  test('foreign keys are enforced, and can be suspended', async () => {
    await schema.create('users', (table) => {
      table.id()
    })
    await schema.create('posts', (table) => {
      table.id()
      table.foreignId('user_id').constrained('users').cascadeOnDelete()
    })

    const posts = new QueryBuilder(connection, 'posts')

    // The FK is real: an orphan row is rejected.
    await expect(posts.insert({ user_id: 99 })).rejects.toThrow()

    await schema.withoutForeignKeyConstraints(async () => {
      await posts.insert({ user_id: 99 })
    })
    expect(await posts.count()).toBe(1)
  })

  test('cascade on delete actually cascades', async () => {
    await schema.create('users', (table) => {
      table.id()
    })
    await schema.create('posts', (table) => {
      table.id()
      table.foreignId('user_id').constrained('users').cascadeOnDelete()
    })

    const users = new QueryBuilder(connection, 'users')
    const posts = new QueryBuilder(connection, 'posts')

    const id = await users.insertGetId({})
    await posts.insert({ user_id: id })

    await users.where('id', id).delete()

    expect(await posts.count()).toBe(0)
  })

  test('toSql compiles without touching the database', () => {
    const plan = new Blueprint('probe').create()
    plan.id()

    expect(schema.toSql(plan)).toEqual([
      'create table "probe" ("id" integer primary key autoincrement not null)'
    ])
  })
})
