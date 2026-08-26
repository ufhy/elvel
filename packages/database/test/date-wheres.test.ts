import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

/**
 * The date comparisons, run against a real database rather than asserted as SQL.
 *
 * `grammar.test.ts` pins the SQL each dialect emits. This file asks the other
 * question, which the SQL cannot answer: do the right rows come back? The two
 * come apart in a specific way — `strftime('%m', …)` answers `'08'`, and SQLite
 * compares text to a bound number by comparing *types* first, so a query with
 * perfectly correct-looking SQL returns nothing at all.
 */
class Entry extends Model {
  static override table = 'entries'
  static override timestamps = false

  declare id: number
  declare title: string
  declare created_at: string
}

let app: Application

beforeEach(async () => {
  app = new Application(process.cwd())

  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  await app.register(DatabaseServiceProvider)
  await app.boot()

  const connection = await app.make('db').connection()

  await connection.statement(
    'create table entries (id integer primary key, title text, created_at text)'
  )

  await connection.statement(
    'insert into entries values ' +
      "(1,'new year','2026-01-01 09:00:00')," +
      "(2,'august morning','2026-08-25 09:30:00')," +
      "(3,'august evening','2026-08-25 21:45:00')," +
      "(4,'last august','2025-08-03 12:00:00')"
  )
})

const titles = async (query: {
  get: () => Promise<{ map: (fn: (row: Entry) => string) => { all: () => string[] } }>
}) =>
  (await query.get())
    .map((entry) => entry.title)
    .all()
    .sort()

describe('whereDate', () => {
  test('compares the day, ignoring the time', async () => {
    expect<string[]>(await titles(Entry.query().whereDate('created_at', '2026-08-25'))).toEqual([
      'august evening',
      'august morning'
    ])
  })

  test('and takes an operator', async () => {
    expect<string[]>(
      await titles(Entry.query().whereDate('created_at', '>', '2026-01-01'))
    ).toEqual(['august evening', 'august morning'])
  })

  test('a Date is formatted to the part being compared', async () => {
    const found = await titles(
      Entry.query().whereDate('created_at', new Date('2026-08-25T21:45:00Z'))
    )

    // The time on the Date is dropped, because the comparison is against the day.
    expect<string[]>(found).toEqual(['august evening', 'august morning'])
  })
})

describe('whereTime', () => {
  test('compares the clock, ignoring the day', async () => {
    expect<string[]>(await titles(Entry.query().whereTime('created_at', '09:00:00'))).toEqual([
      'new year'
    ])
  })

  test('and an operator narrows it across days', async () => {
    expect<string[]>(await titles(Entry.query().whereTime('created_at', '>', '12:00:00'))).toEqual([
      'august evening'
    ])
  })
})

describe('whereDay, whereMonth, whereYear', () => {
  /**
   * A number, not a string, which is how anybody writes it.
   *
   * This is the assertion the SQL alone cannot make: `strftime('%m', …)` answers
   * `'08'` and SQLite compares `'08' = 8` as false, so an implementation that
   * bound the number unchanged would answer **nothing** while looking right.
   */
  test('a month given as a number still matches', async () => {
    expect<string[]>(await titles(Entry.query().whereMonth('created_at', 8))).toEqual([
      'august evening',
      'august morning',
      'last august'
    ])
  })

  test('and as a padded string', async () => {
    expect<string[]>(await titles(Entry.query().whereMonth('created_at', '08'))).toEqual([
      'august evening',
      'august morning',
      'last august'
    ])
  })

  test('whereDay compares the day of the month', async () => {
    expect<string[]>(await titles(Entry.query().whereDay('created_at', 25))).toEqual([
      'august evening',
      'august morning'
    ])
  })

  test('whereYear compares the year', async () => {
    expect<string[]>(await titles(Entry.query().whereYear('created_at', 2025))).toEqual([
      'last august'
    ])
  })

  test('and they compose with each other', async () => {
    const found = await titles(
      Entry.query().whereYear('created_at', 2026).whereMonth('created_at', 8)
    )

    expect<string[]>(found).toEqual(['august evening', 'august morning'])
  })
})

describe('the or twins', () => {
  test('orWhereDate joins with or', async () => {
    const found = await titles(
      Entry.query().where('title', 'new year').orWhereDate('created_at', '2025-08-03')
    )

    expect<string[]>(found).toEqual(['last august', 'new year'])
  })

  test('orWhereYear too', async () => {
    const found = await titles(
      Entry.query().where('title', 'new year').orWhereYear('created_at', 2025)
    )

    expect<string[]>(found).toEqual(['last august', 'new year'])
  })
})

/**
 * `union` and `unionAll`, against the database.
 *
 * The interesting part is the wrapping, and it is per dialect: SQLite refuses a
 * bare `(select …)` on the right of a `union` and needs `select * from (…)`. A
 * grammar emitting the base form would produce SQL that reads perfectly and is a
 * syntax error, which only a real query can tell you.
 */
describe('union', () => {
  test('joins two queries and removes duplicates', async () => {
    const db = app.make('db')
    const other = (await db.table('entries')).where('title', 'new year')
    const rows = await (await db.table('entries')).where('title', 'new year').union(other).get()

    // The same row from both sides, once after the union removes the duplicate.
    expect<number>(rows.length).toBe(1)
  })

  test('unionAll keeps them', async () => {
    const db = app.make('db')
    const other = (await db.table('entries')).where('title', 'new year')
    const rows = await (await db.table('entries')).where('title', 'new year').unionAll(other).get()

    expect<number>(rows.length).toBe(2)
  })

  test('takes a callback as well as a builder', async () => {
    const db = app.make('db')
    const rows = await (await db.table('entries'))
      .where('title', 'new year')
      .union((query) => {
        query.from('entries').where('title', 'last august')
      })
      .get()

    expect<number>(rows.length).toBe(2)
  })

  /**
   * Both sides' bindings, in reading order.
   *
   * A placeholder is bound by its position, so the left query's values have to be
   * pushed before the union's — swapped, the query still runs and answers the
   * wrong rows, which is worse than an error.
   */
  test('binds both sides in the order the SQL reads them', async () => {
    const db = app.make('db')
    const rows = await (await db.table('entries'))
      .where('title', 'august morning')
      .union((query) => {
        query.from('entries').where('title', 'last august')
      })
      .get()

    expect<string[]>(
      rows
        .map((row) => String(row.title))
        .all()
        .sort()
    ).toEqual(['august morning', 'last august'])
  })
})
