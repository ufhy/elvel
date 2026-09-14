import { beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { QueryBuilder } from '../src/query/builder.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

/**
 * The families the builder did not have.
 *
 * Each one was a nested closure, a `whereRaw`, or a second query at every call
 * site. `dialects.test.ts` runs the ones whose syntax differs against real
 * servers; this asserts the SQL and the behaviour on SQLite.
 */

let connection: BunSqlConnection
let schema: SchemaBuilder

const users = () => new QueryBuilder(connection, 'users')
const orders = () => new QueryBuilder(connection, 'orders')

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  schema = new SchemaBuilder(connection)

  await schema.create('users', (table) => {
    table.id()
    table.string('name')
    table.string('email').nullable()
    table.integer('spend').default(0)
    table.text('meta').nullable()
  })

  await schema.create('orders', (table) => {
    table.id()
    table.integer('user_id')
    table.integer('total')
    table.integer('starts_at').nullable()
    table.integer('ends_at').nullable()
  })
})

describe('one comparison against several columns', () => {
  test('whereAny joins them with or, inside their own group', () => {
    expect(users().where('spend', '>', 1).whereAny(['name', 'email'], 'like', '%a%').toSql()).toBe(
      'select * from "users" where "spend" > ? and ("name" like ? or "email" like ?)'
    )
  })

  test('whereAll joins them with and', () => {
    expect(users().whereAll(['name', 'email'], 'like', '%a%').toSql()).toBe(
      'select * from "users" where ("name" like ? and "email" like ?)'
    )
  })

  /** Negating the group, which is not the same as negating each comparison. */
  test('whereNone negates the group as a whole', () => {
    expect(users().whereNone(['name', 'email'], 'like', '%bot%').toSql()).toBe(
      'select * from "users" where not ("name" like ? or "email" like ?)'
    )
  })

  test('two arguments mean equals', () => {
    expect(users().whereAny(['name', 'email'], 'ada').toSql()).toContain(
      '"name" = ? or "email" = ?'
    )
  })

  test('and no columns is no clause at all', () => {
    expect(users().whereAny([], 'ada').toSql()).toBe('select * from "users"')
  })

  test('they find the rows they say they do', async () => {
    await users().insert([
      { name: 'Ada', email: 'ada@example.test' },
      { name: 'Grace', email: 'grace@example.test' }
    ])

    expect(await users().whereAny(['name', 'email'], 'like', 'Ada%').count()).toBe(1)
    expect(await users().whereNone(['name', 'email'], 'like', 'Ada%').count()).toBe(1)
  })
})

describe('comparing against columns', () => {
  test('a value between two columns', async () => {
    await orders().insert([
      { user_id: 1, total: 1, starts_at: 10, ends_at: 20 },
      { user_id: 1, total: 2, starts_at: 30, ends_at: 40 }
    ])

    expect(users().toSql()).toBe('select * from "users"')
    expect(await orders().whereBetweenColumns(15, ['starts_at', 'ends_at']).count()).toBe(1)
    expect(await orders().whereNotBetweenColumns(15, ['starts_at', 'ends_at']).count()).toBe(1)
  })

  /** Lexicographic, which is what a keyset page actually needs. */
  test('a tuple comparison is not a column-by-column one', async () => {
    await orders().insert([
      { user_id: 1, total: 50 },
      { user_id: 2, total: 10 }
    ])

    expect(orders().whereRowValues(['user_id', 'total'], '>', [1, 20]).toSql()).toBe(
      'select * from "orders" where ("user_id", "total") > (?, ?)'
    )
    // Both match: (1, 50) because 50 > 20, and (2, 10) because 2 > 1 — which
    // `user_id > 1 and total > 20` would have excluded.
    expect(await orders().whereRowValues(['user_id', 'total'], '>', [1, 20]).count()).toBe(2)
  })

  test('and it insists on as many values as columns', () => {
    expect(() => orders().whereRowValues(['a', 'b'], '>', [1])).toThrow('as many values as columns')
  })

  /** `where('x', null)` becomes `is null`, and a bound null matches nothing. */
  test('null-safe equality compares two nulls as equal', async () => {
    await users().insert([
      { name: 'Ada', email: null },
      { name: 'Grace', email: 'g@example.test' }
    ])

    expect(await users().whereNullSafeEquals('email', null).count()).toBe(1)
    expect(await users().whereNotNullSafeEquals('email', null).count()).toBe(1)
  })
})

describe('json', () => {
  beforeEach(async () => {
    await users().insert([
      { name: 'Ada', meta: JSON.stringify({ tags: ['a', 'b'], beta: null }) },
      { name: 'Grace', meta: JSON.stringify({ tags: ['c'] }) }
    ])
  })

  /** A key holding null is present; one that was never written is not. */
  test('a key that holds null is still a key', async () => {
    expect(await users().whereJsonContainsKey('meta->beta').count()).toBe(1)
    expect(await users().whereJsonDoesntContainKey('meta->beta').count()).toBe(1)
  })

  test('overlapping arrays share a member', async () => {
    expect(await users().whereJsonOverlaps('meta->tags', ['b', 'z']).count()).toBe(1)
    expect(await users().whereJsonDoesntOverlap('meta->tags', ['z']).count()).toBe(2)
  })

  test('and a path is required to ask about a key', () => {
    expect(() => users().whereJsonContainsKey('meta').toSql()).toThrow('needs a path')
  })
})

describe('like, negated', () => {
  test('whereNotLike is the negative whereLike never had', () => {
    expect(users().whereNotLike('name', '%bot%').toSql()).toBe(
      'select * from "users" where "name" not like ?'
    )
  })
})

describe('raw and sub-select', () => {
  test('a sub-select is one column, with its bindings read first', async () => {
    await users().insert({ name: 'Ada' })
    await orders().insert([
      { user_id: 1, total: 10 },
      { user_id: 1, total: 30 }
    ])

    const query = users()
      .select('name')
      .selectSub(
        orders()
          .selectRaw('count(*)')
          .whereColumn('orders.user_id', '=', 'users.id')
          .where('total', '>', 20),
        'big_orders'
      )
      .where('name', 'Ada')

    const [row] = await query.get()

    expect(row?.big_orders).toBe(1)
    // The sub-select's binding is read before the outer where's.
    expect(query.getBindings()).toEqual([20, 'Ada'])
  })

  test('orderByRaw carries its own bindings', async () => {
    await users().insert([{ name: 'Ada' }, { name: 'Grace' }])

    const names = await users().orderByRaw('length(name) desc').pluck('name')

    expect(names.all()).toEqual(['Grace', 'Ada'])
  })

  test('fromRaw is the from clause verbatim', () => {
    expect(users().fromRaw('(select 1 as one) as t').toSql()).toBe(
      'select * from (select 1 as one) as t'
    )
  })

  test('rawValue answers one expression', async () => {
    await users().insert([{ name: 'Ada' }, { name: 'Grace' }])

    expect(await users().rawValue<number>('count(*)')).toBe(2)
  })
})

describe('joins', () => {
  test('joinWhere compares against a value, in the on clause', () => {
    expect(users().joinWhere('orders', 'orders.total', '>', 20).toSql()).toBe(
      'select * from "users" inner join "orders" on "orders"."total" > ?'
    )
  })

  test('a left join keeps its condition where a where would not', async () => {
    await users().insert([{ name: 'Ada' }, { name: 'Grace' }])
    await orders().insert({ user_id: 1, total: 10 })

    const rows = await users().leftJoinWhere('orders', 'orders.total', '>', 100).get()

    expect(rows.count()).toBe(2)
  })

  /** SQLite has no lateral join, and says so rather than emitting one. */
  test('a lateral join is refused where it does not exist', () => {
    expect(() => users().joinLateral(orders().selectRaw('*').limit(1), 'recent').toSql()).toThrow(
      'sqlite has no lateral join'
    )
  })
})

describe('the statement, and what runs it', () => {
  test('toRawSql writes the bindings in, in order', () => {
    expect(users().where('name', "O'Hara").where('spend', '>', 5).toRawSql()).toBe(
      `select * from "users" where "name" = 'O''Hara' and "spend" > 5`
    )
  })

  test('beforeQuery runs once, however often the query is compiled', () => {
    let ran = 0
    const query = users().beforeQuery((builder) => {
      ran += 1
      builder.where('spend', '>', 0)
    })

    query.toSql()
    query.toSql()

    expect(ran).toBe(1)
    expect(query.toSql()).toContain('"spend" > ?')
  })

  test('afterQuery sees the rows', async () => {
    await users().insert([{ name: 'Ada' }, { name: 'Grace' }])

    const rows = await users()
      .afterQuery((found) => found.filter((row) => row.name === 'Ada'))
      .get()

    expect(rows.count()).toBe(1)
  })

  /** `first()` on a query that matched three answers one and says nothing. */
  test('sole insists there is exactly one', async () => {
    await users().insert([{ name: 'Ada' }, { name: 'Ada' }])

    expect(users().where('name', 'Grace').sole()).rejects.toThrow('No rows found')
    expect(users().where('name', 'Ada').sole()).rejects.toThrow('More than one row')

    await users().where('id', 2).delete()

    expect(await users().soleValue<string>('name')).toBe('Ada')
  })

  test('an index hint is ignored where there are no hints', () => {
    expect(users().forceIndex('users_name_index').toSql()).toBe('select * from "users"')
  })

  test('and a timeout says where to set one instead', () => {
    expect(() => users().timeout(5).toSql()).toThrow('no per-statement timeout')
  })
})

describe('writing from another query', () => {
  test('insertOrIgnoreUsing skips the rows that collide', async () => {
    await schema.create('totals', (table) => {
      table.integer('user_id').unique()
      table.integer('total')
    })
    await orders().insert([
      { user_id: 1, total: 10 },
      { user_id: 1, total: 20 },
      { user_id: 2, total: 30 }
    ])

    const totals = new QueryBuilder(connection, 'totals')

    await totals.insertOrIgnoreUsing(['user_id', 'total'], orders().select('user_id', 'total'))

    expect((await totals.pluck('user_id')).all()).toEqual([1, 2])
  })

  test('updateFrom takes its values from the joined table', async () => {
    await users().insert([{ name: 'Ada' }, { name: 'Grace' }])
    await orders().insert({ user_id: 1, total: 42 })

    await users().join('orders', 'orders.user_id', '=', 'users.id').updateFrom({ spend: 42 })

    expect(await users().where('spend', 42).count()).toBe(1)
  })
})
