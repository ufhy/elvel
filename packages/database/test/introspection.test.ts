import { beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

/**
 * What the schema can say about itself.
 *
 * Three console commands used to carry their own three dialects of
 * introspection SQL inline, where no application and no other command could
 * reach it. `dialects.test.ts` runs these against real Postgres and MySQL; this
 * covers the shapes and the two destructive helpers, on SQLite.
 */

let connection: BunSqlConnection
let schema: SchemaBuilder

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  schema = new SchemaBuilder(connection)

  await schema.create('users', (table) => {
    table.id()
    table.string('email').unique()
    table.string('name').nullable()
    table.integer('votes').default(7)
  })

  await schema.create('posts', (table) => {
    table.id()
    table.foreignId('user_id').constrained('users').cascadeOnDelete()
    table.string('title')
    table.index(['title'])
  })
})

describe('tables and views', () => {
  test('every table is listed, in order', async () => {
    expect(await schema.getTableListing()).toEqual(['posts', 'users'])
  })

  test('a view is a view and not a table', async () => {
    await connection.statement('create view recent as select * from posts')

    const views = await schema.getViews()

    expect(views.map((view) => view.name)).toEqual(['recent'])
    expect(views[0]?.definition).toContain('select * from posts')
    expect(await schema.getTableListing()).not.toContain('recent')
    expect(await schema.hasView('recent')).toBe(true)
    expect(await schema.hasView('posts')).toBe(false)
  })
})

describe('columns', () => {
  test('carry their type, nullability and default', async () => {
    const columns = await schema.getColumns('users')
    const by = (name: string) => columns.find((column) => column.name === name)

    expect(columns.map((column) => column.name)).toEqual(['id', 'email', 'name', 'votes'])
    expect(by('name')?.nullable).toBe(true)
    expect(by('email')?.nullable).toBe(false)
    expect(by('votes')?.default).toBe('7')
    expect(by('email')?.typeName).toBe('varchar')
  })

  /** A single-column integer key is the rowid, and increments whatever it says. */
  test('and say when the server fills them in', async () => {
    const columns = await schema.getColumns('users')

    expect(columns.find((column) => column.name === 'id')?.autoIncrement).toBe(true)
    expect(columns.find((column) => column.name === 'votes')?.autoIncrement).toBe(false)
  })

  test('getColumnType names one, or nothing', async () => {
    expect(await schema.getColumnType('users', 'email')).toBe('varchar')
    expect(await schema.getColumnType('users', 'nope')).toBeUndefined()
  })

  test('hasColumns wants all of them', async () => {
    expect(await schema.hasColumns('users', ['email', 'name'])).toBe(true)
    expect(await schema.hasColumns('users', ['email', 'nope'])).toBe(false)
  })
})

describe('indexes and keys', () => {
  test('an index names the columns it covers', async () => {
    const indexes = await schema.getIndexes('posts')

    expect(indexes.map((index) => index.name)).toContain('posts_title_index')
    expect(indexes.find((index) => index.name === 'posts_title_index')?.columns).toEqual(['title'])
  })

  test('a unique index says so', async () => {
    const unique = (await schema.getIndexes('users')).find((index) => index.unique)

    expect(unique?.columns).toEqual(['email'])
  })

  test('a foreign key names both sides and what happens on delete', async () => {
    const keys = await schema.getForeignKeys('posts')

    expect(keys).toHaveLength(1)
    expect(keys[0]?.name).toBe('posts_user_id_foreign')
    expect(keys[0]?.columns).toEqual(['user_id'])
    expect(keys[0]?.foreignTable).toBe('users')
    expect(keys[0]?.foreignColumns).toEqual(['id'])
    expect(keys[0]?.onDelete).toBe('cascade')
  })

  test('hasForeignKey finds it by name or by columns', async () => {
    expect(await schema.hasForeignKey('posts', 'posts_user_id_foreign')).toBe(true)
    expect(await schema.hasForeignKey('posts', ['user_id'])).toBe(true)
    expect(await schema.hasForeignKey('posts', ['title'])).toBe(false)
  })
})

describe('conditional alterations', () => {
  test('run only when the column is or is not there', async () => {
    await schema.whenTableHasColumn('users', 'name', (table) => {
      table.string('nickname').nullable()
    })
    await schema.whenTableDoesntHaveColumn('users', 'nickname', (table) => {
      table.string('never').nullable()
    })
    await schema.whenTableDoesntHaveColumn('users', 'handle', (table) => {
      table.string('handle').nullable()
    })

    expect(await schema.hasColumns('users', ['nickname', 'handle'])).toBe(true)
    expect(await schema.hasColumn('users', 'never')).toBe(false)
  })
})

describe('dropping everything', () => {
  /** There is no order that satisfies a cycle, so the keys go off first. */
  test('dropAllTables leaves nothing, foreign keys and all', async () => {
    await schema.dropAllTables()

    expect(await schema.getTableListing()).toEqual([])
  })

  test('dropAllViews leaves the tables alone', async () => {
    await connection.statement('create view recent as select * from posts')

    await schema.dropAllViews()

    expect(await schema.getViews()).toEqual([])
    expect(await schema.getTableListing()).toEqual(['posts', 'users'])
  })
})
