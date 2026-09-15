import { describe, expect, test } from 'bun:test'
import { BunSqlConnection, QueryBuilder, SchemaBuilder } from '@elvel/database'
import { reachable } from '../../../tests/support/dialects.ts'
import { explainFor, readPlan } from '../src/explain.ts'

/**
 * The one thing in this package that issues a statement of its own.
 *
 * So the first tests here are about what it refuses to ask, not about what it
 * understands: an `EXPLAIN` that ran a write, or a second statement after a
 * semicolon, would be a recorder doing damage to the thing it was watching.
 */
describe('what may be explained at all', () => {
  test('a select, on the three dialects that can answer', () => {
    expect(explainFor('sqlite', 'select * from users')).toBe(
      'explain query plan select * from users'
    )
    expect(explainFor('postgres', 'select * from users')).toContain('format json')
    expect(explainFor('mysql', 'select * from users')).toContain('format=json')
  })

  /** Never ANALYZE: that runs the statement a second time. */
  test('and never the form that would execute it again', () => {
    for (const dialect of ['sqlite', 'postgres', 'mysql', 'mariadb']) {
      expect(String(explainFor(dialect, 'select 1')).toLowerCase()).not.toContain('analyze')
    }
  })

  test('a write is refused, whatever it is', () => {
    for (const sql of [
      'delete from users',
      'update users set name = ?',
      'insert into users (id) values (?)',
      'drop table users',
      '  DELETE FROM users'
    ]) {
      expect(explainFor('postgres', sql)).toBeUndefined()
    }
  })

  test('and so is a second statement smuggled in after a semicolon', () => {
    expect(explainFor('postgres', 'select 1; drop table users')).toBeUndefined()
    // A trailing semicolon is punctuation, not a second statement.
    expect(explainFor('postgres', 'select 1;')).toBeDefined()
  })

  test('a dialect nothing is known about is not guessed at', () => {
    expect(explainFor('oracle', 'select 1')).toBeUndefined()
  })
})

/**
 * The shapes three servers actually answer with, captured from them.
 *
 * Postgres hands back the plan already decoded; MySQL hands back JSON as a
 * string and renamed its own access type along the way. Both were measured
 * rather than assumed — the first version of this reader printed
 * `[object Object]`.
 */
describe('reading a plan', () => {
  test('SQLite says SCAN for a full read and SEARCH for an indexed one', () => {
    expect(readPlan('sqlite', [{ detail: 'SCAN probe_scan' }]).scans).toEqual(['probe_scan'])
    expect(
      readPlan('sqlite', [{ detail: 'SEARCH probe_scan USING INTEGER PRIMARY KEY (rowid=?)' }])
        .scans
    ).toEqual([])
  })

  test('Postgres names the node type and the relation', () => {
    const seq = [
      { 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'probe_scan' } }] }
    ]
    const indexed = [
      { 'QUERY PLAN': [{ Plan: { 'Node Type': 'Index Scan', 'Relation Name': 'probe_scan' } }] }
    ]

    expect(readPlan('postgres', seq).scans).toEqual(['probe_scan'])
    expect(readPlan('postgres', indexed).scans).toEqual([])
  })

  /** 8.4 answers `table`; older servers answer `ALL`. Both are the same read. */
  test('MySQL, in both of its spellings', () => {
    const modern = [
      {
        EXPLAIN: JSON.stringify({
          query_plan: {
            inputs: [
              {
                operation: 'Table scan on probe_scan',
                table_name: 'probe_scan',
                access_type: 'table'
              }
            ]
          }
        })
      }
    ]
    const classic = [
      {
        EXPLAIN: JSON.stringify({
          query_block: { table: { table_name: 'users', access_type: 'ALL' } }
        })
      }
    ]
    const lookup = [
      {
        EXPLAIN: JSON.stringify({
          query_plan: {
            inputs: [
              {
                operation: 'Single-row index lookup on probe_scan using PRIMARY',
                table_name: 'probe_scan',
                access_type: 'const'
              }
            ]
          }
        })
      }
    ]

    expect(readPlan('mysql', modern).scans).toEqual(['probe_scan'])
    expect(readPlan('mysql', classic).scans).toEqual(['users'])
    expect(readPlan('mysql', lookup).scans).toEqual([])
  })

  test('a table read twice is named once', () => {
    const twice = [
      {
        'QUERY PLAN': [
          {
            Plan: {
              'Node Type': 'Hash Join',
              Plans: [
                { 'Node Type': 'Seq Scan', 'Relation Name': 'users' },
                { 'Node Type': 'Seq Scan', 'Relation Name': 'users' }
              ]
            }
          }
        ]
      }
    ]

    expect(readPlan('postgres', twice).scans).toEqual(['users'])
  })

  test('and an answer that is not a plan at all is not an error', () => {
    expect(readPlan('mysql', [{ EXPLAIN: 'not json' }]).scans).toEqual([])
    expect(readPlan('postgres', []).scans).toEqual([])
  })
})

/**
 * Against the servers themselves, because a plan is what a server says.
 *
 * Every assertion above is about a payload captured from one of these. This is
 * what keeps that capture honest when a server is upgraded — MySQL renamed its
 * own access type between versions, and nothing but a real server would have
 * said so.
 */
const available = await reachable('lens-explain')

for (const { name, config } of available) {
  describe(`explain: ${name}`, () => {
    const table = `lens_explain_${Date.now().toString(36)}`

    test('a column with no index reads the whole table, a key does not', async () => {
      const connection = await BunSqlConnection.make('lens-explain', config)
      const schema = new SchemaBuilder(connection)

      await schema.dropIfExists(table)
      await schema.create(table, (blueprint) => {
        blueprint.id()
        blueprint.string('note')
      })

      try {
        await new QueryBuilder(connection, table).insert(
          Array.from({ length: 200 }, () => ({ note: 'n' }))
        )

        const scan = new QueryBuilder(connection, table).where('note', 'n')
        const keyed = new QueryBuilder(connection, table).where('id', 1)

        const plans = await Promise.all(
          [scan, keyed].map(async (query) => {
            const statement = explainFor(connection.grammar.dialect, query.toSql())

            expect(statement).toBeDefined()

            const rows = await connection.select<Record<string, unknown>>(
              statement as string,
              query.getBindings()
            )

            return readPlan(connection.grammar.dialect, rows)
          })
        )

        expect(plans[0]?.scans).toEqual([table])
        expect(plans[1]?.scans).toEqual([])
      } finally {
        await schema.dropIfExists(table)
        await connection.disconnect()
      }
    })
  })
}
