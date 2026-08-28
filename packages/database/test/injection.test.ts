import { beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { QueryBuilder } from '../src/query/builder.ts'

/**
 * What reaches SQL as itself, and what cannot.
 *
 * Three kinds of thing go into a compiled query. A **value** is a binding, always.
 * An **identifier** is quoted, with an embedded quote doubled. A **keyword** — a
 * join type, a sort direction — is neither, so it is checked against a list.
 *
 * The third kind is the one that was wrong. `orderBy(column, direction)` is typed
 * `'asc' | 'desc'` and a type says nothing at runtime about a value that arrived as
 * `?dir=…`, so the direction was interpolated straight into the SQL. Measured
 * against a live SQLite database before this was fixed:
 *
 * ```
 * order by "name" asc, (CASE WHEN (SELECT secret FROM users WHERE name = 'Ada')
 *                       LIKE 't%' THEN 0 ELSE 1 END) asc
 * ```
 *
 * It ran. The row order then answers the guess — a blind oracle that needs no
 * second statement, so whether the driver permits one is beside the point.
 */
let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })

  await connection.unprepared(
    `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, secret TEXT)`
  )
})

const users = () => new QueryBuilder(connection, 'users')

describe('a keyword is checked, not quoted', () => {
  const payload =
    "asc, (CASE WHEN (SELECT secret FROM users WHERE name = 'Ada') LIKE 't%' THEN 0 ELSE 1 END) asc"

  test('a sort direction that is not asc or desc is refused', () => {
    expect(() => users().orderBy('name', payload as never)).toThrow(
      /Order direction must be "asc" or "desc"/
    )
  })

  test('and the refusal names what it saw, so the caller can find it', () => {
    expect(() => users().orderBy('name', 'ASC; DROP TABLE users' as never)).toThrow(
      /saw \[ASC; DROP TABLE users\]/
    )
  })

  /** Case is not the mistake being caught: `DESC` is a direction. */
  test('but the case of a real direction is not the caller problem', () => {
    expect(
      users()
        .orderBy('name', 'DESC' as never)
        .toSql()
    ).toContain('order by "name" desc')
  })

  /**
   * And the grammar refuses it a second time.
   *
   * The builder throws, which is where a developer wants the error. This is the
   * backstop for anything that writes `orders` without going through it — a
   * relation, a paginator, a future method — and it degrades to `asc` rather than
   * throwing, because a grammar cannot say anything useful about a bug three layers
   * up.
   */
  test('the grammar writes asc for anything it does not recognise', () => {
    const builder = users()

    // Past the front door, as another part of the framework could.
    ;(builder as unknown as { query: { orders: unknown[] } }).query.orders.push({
      column: 'name',
      direction: payload
    })

    const sql = builder.toSql()

    expect(sql).toBe('select * from "users" order by "name" asc')
    expect(sql).not.toContain('CASE WHEN')
  })

  test('and inner for a join type it does not recognise', () => {
    const builder = users()

    ;(builder as unknown as { query: { joins: unknown[] } }).query.joins.push({
      type: 'left join x on 1=1 -- ',
      table: 'posts',
      wheres: []
    })

    expect(builder.toSql()).toBe('select * from "users" inner join "posts"')
  })
})

describe('what was already safe stays safe', () => {
  test('a hostile column name never leaves its quotes', () => {
    const sql = users()
      .select('a"; DROP TABLE users; --')
      .where('name"; DELETE FROM users; --', '=', 'ada')
      .toSql()

    // Doubled quotes, as Laravel's grammar does: one identifier, not two statements.
    expect(sql).toContain('"a""; DROP TABLE users; --"')
    expect(sql).toContain('"name""; DELETE FROM users; --"')
  })

  test('a hostile table name either', () => {
    const sql = new QueryBuilder(connection, 'users"; DROP TABLE users; --').toSql()

    expect(sql).toBe('select * from "users""; DROP TABLE users; --"')
  })

  test('an operator is whitelisted', () => {
    expect(() => users().where('id', '= 1 OR 1=1 --' as never, 1)).toThrow(/Unsupported operator/)
  })

  test('and a value is a binding, whatever is in it', () => {
    const builder = users().where('name', '=', "ada'; DROP TABLE users; --")

    expect(builder.toSql()).toBe('select * from "users" where "name" = ?')
    expect(builder.getBindings()).toEqual(["ada'; DROP TABLE users; --"])
  })
})
