import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import type { ConnectionManager } from '../src/connection/manager.ts'
import { DatabaseServiceProvider } from '../src/index.ts'

let db: ConnectionManager

/** A real SQLite database: these are all statements the grammar has to emit. */
beforeEach(async () => {
  const app = new Application(process.cwd())

  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  await app.register(DatabaseServiceProvider)
  await app.boot()

  db = app.make('db')
  const connection = await db.connection()

  await connection.statement(
    'create table sales (id integer primary key, region text, amount integer)'
  )
  await connection.statement("insert into sales values (1,'a',10),(2,'a',20),(3,'b',5)")
})

describe('aggregates', () => {
  test('average is avg under another name', async () => {
    expect(await (await db.table('sales')).average('amount')).toBeCloseTo(11.667, 2)
  })

  /**
   * Joined here rather than in SQL.
   *
   * `group_concat`, `GROUP_CONCAT` and `string_agg` are three spellings with
   * three separator syntaxes, and this is something a caller does once at the end
   * — not worth a grammar branch that has to be right on all three.
   */
  test('implode joins the column', async () => {
    expect(await (await db.table('sales')).implode('region', ',')).toBe('a,a,b')
  })
})

describe('ordering', () => {
  test('inRandomOrder asks the dialect for its function', async () => {
    const sql = (await db.table('sales')).inRandomOrder().toSql()

    // SQLite and Postgres say RANDOM(); MySQL says RAND(), which is a syntax
    // error on the others rather than a wrong answer.
    expect(sql).toContain('order by RANDOM()')
  })

  test('inOrderOf returns the rows in the order asked for', async () => {
    expect<unknown[]>(
      (await (await db.table('sales')).inOrderOf('id', [3, 1, 2]).pluck('id')).all()
    ).toEqual([3, 1, 2])
  })

  test('and survives a limit, which sorting afterwards would not', async () => {
    const first = (
      await (await db.table('sales')).inOrderOf('id', [3, 1, 2]).limit(1).pluck('id')
    ).all()

    // The database applies the order before the limit; a sort in JS could only
    // reorder the row the limit already chose.
    expect(first).toEqual([3])
  })

  test('an empty list of values changes nothing', async () => {
    expect((await (await db.table('sales')).inOrderOf('id', []).get()).count()).toBe(3)
  })

  test('a value with a quote in it does not break the case', async () => {
    const connection = await db.connection()
    await connection.statement("insert into sales values (4,'o''brien',1)")

    const order = (
      await (await db.table('sales')).inOrderOf('region', ["o'brien", 'b']).pluck('id')
    ).all()

    expect(order[0]).toBe(4)
  })

  test('groupByRaw passes the expression through', async () => {
    const rows = await (await db.table('sales'))
      .selectRaw('region, sum(amount) as total')
      .groupByRaw('region')
      .get()

    expect(rows.count()).toBe(2)
  })
})

describe('having', () => {
  const grouped = async () =>
    (await db.table('sales')).select('region').selectRaw('sum(amount) as total').groupBy('region')

  test('havingBetween filters on the aggregate', async () => {
    const rows = await (await grouped()).havingBetween('total', [1, 10]).get()

    expect(rows.all()).toEqual([{ region: 'b', total: 5 }])
  })

  test('havingNull and havingNotNull', async () => {
    expect((await (await grouped()).havingNotNull('total').get()).count()).toBe(2)
    expect((await (await grouped()).havingNull('total').get()).count()).toBe(0)
  })
})

describe('subqueries', () => {
  /**
   * The reason `fromSub` exists, and the bug it had.
   *
   * `from` is quoted as an identifier, so a subquery put there became one very
   * long table name that does not exist. It carries an expression now, kept in
   * its own field because every write path still needs a real table.
   */
  test('fromSub selects from a grouped subquery', async () => {
    const inner = (await db.table('sales'))
      .select('region')
      .selectRaw('sum(amount) as total')
      .groupBy('region')

    const outer = (await db.table('x')).fromSub(inner, 't').where('total', '>', 10)

    expect(outer.toSql()).toContain('from (select')
    expect((await outer.get()).all()).toEqual([{ region: 'a', total: 30 }])
  })

  test('crossJoinSub pairs every row with the subquery', async () => {
    const totals = (await db.table('sales')).selectRaw('sum(amount) as grand')
    const rows = await (await db.table('sales')).crossJoinSub(totals, 'g').get()

    expect(rows.count()).toBe(3)
    expect((rows.first() as { grand: number }).grand).toBe(35)
  })

  /**
   * `toSql()` and `getBindings()` each compiled the whole query, so a subquery was
   * compiled twice for one embed and a nested one four times. They are wrappers
   * around a single `compile()` now, and the two halves have to keep agreeing:
   * a builder whose SQL and bindings came from different passes would bind the
   * wrong values the moment compilation stopped being pure.
   */
  test('compile answers the same as the two methods it replaced', async () => {
    const query = (await db.table('sales'))
      .select('region')
      .where('amount', '>', 5)
      .where('region', 'a')
      .groupBy('region')

    const compiled = query.compile()

    expect<string>(compiled.sql).toBe(query.toSql())
    expect<unknown[]>(compiled.bindings).toEqual(query.getBindings())
    expect<unknown[]>(compiled.bindings).toEqual([5, 'a'])
  })

  /** A subquery embed still carries the inner bindings, in order, ahead of its own. */
  test('an embedded subquery keeps its bindings in front', async () => {
    const inner = (await db.table('sales')).select('region').where('amount', '>', 5)
    const outer = (await db.table('sales'))
      .joinSub(inner, 's', 's.region', '=', 'sales.region')
      .where('sales.amount', '<', 100)

    expect<unknown[]>(outer.getBindings()).toEqual([5, 100])
    expect<boolean>(outer.toSql().includes('(select')).toBe(true)
  })

  test('insertUsing copies rows without bringing them here', async () => {
    const connection = await db.connection()
    await connection.statement('create table archive (id integer, region text, amount integer)')

    await (await db.table('archive')).insertUsing(
      ['id', 'region', 'amount'],
      (await db.table('sales')).select('id', 'region', 'amount')
    )

    expect(await (await db.table('archive')).count()).toBe(3)
  })
})

describe('counters', () => {
  test('incrementEach changes several columns in one statement', async () => {
    const connection = await db.connection()
    await connection.statement('alter table sales add column views integer default 0')

    await (await db.table('sales')).where('id', 1).incrementEach({ amount: 5, views: 2 })

    const row = (await (await db.table('sales')).where('id', 1).first()) as {
      amount: number
      views: number
    }

    // One update, not two: two updates to the same row race, and the second
    // overwrites what the first read.
    expect(row.amount).toBe(15)
    expect(row.views).toBe(2)
  })

  test('decrementEach is the same in the other direction', async () => {
    await (await db.table('sales')).where('id', 2).decrementEach({ amount: 5 })

    expect<unknown>(await (await db.table('sales')).where('id', 2).value('amount')).toBe(15)
  })

  test('a non-numeric amount is refused rather than written', async () => {
    await expect((await db.table('sales')).incrementEach({ amount: Number.NaN })).rejects.toThrow(
      /needs a number/
    )
  })
})

describe('walking', () => {
  test('forPageAfterId pages by key rather than offset', async () => {
    const first = (await (await db.table('sales')).forPageAfterId(2, 0).pluck('id')).all()
    const next = (
      await (await db.table('sales')).forPageAfterId(2, first[1] as number).pluck('id')
    ).all()

    expect<unknown[]>(first).toEqual([1, 2])
    expect<unknown[]>(next).toEqual([3])
  })

  test('and drops an existing order on the same column', async () => {
    const sql = (await db.table('sales')).orderByDesc('id').forPageAfterId(2, 0).toSql()

    // Two orders on one column is not a thing; the descending one has to go.
    expect(sql).toContain('order by "id" asc')
    expect(sql).not.toContain('desc')
  })

  test('cursor walks everything without holding it', async () => {
    const seen: number[] = []

    for await (const row of (await db.table('sales')).cursor('id', 2)) {
      seen.push(row.id as number)
    }

    expect<number[]>(seen).toEqual([1, 2, 3])
  })

  /**
   * The reason it pages by key.
   *
   * Deleting while walking shifts an offset window back and skips rows it never
   * handed over. Keyed paging cannot: the next page starts after the last id it
   * actually saw.
   */
  test('and does not skip rows when something is deleted mid-walk', async () => {
    const seen: number[] = []

    for await (const row of (await db.table('sales')).cursor('id', 1)) {
      seen.push(row.id as number)

      if (row.id === 1) await (await db.table('sales')).where('id', 1).delete()
    }

    expect<number[]>(seen).toEqual([1, 2, 3])
  })
})
