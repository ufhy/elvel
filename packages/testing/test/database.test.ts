import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { reachable } from '../../../tests/support/dialects.ts'
import {
  assertDatabaseCount,
  assertDatabaseHas,
  assertDatabaseMissing,
  assertNotSoftDeleted,
  assertSoftDeleted,
  forgetMigrations,
  refreshDatabase,
  type TestConnectionManager
} from '../src/database.ts'

/**
 * `refreshDatabase()` against real servers.
 *
 * The whole point of it is that nothing survives a test, and that is not
 * provable with a double: a fake `transaction()` would roll back because it was
 * written to, not because the database did. Every dialect is asked the same two
 * questions — does a write inside a test disappear, and does a handler that
 * resolves the connection *by name* land inside the same transaction.
 *
 * The second is the one that fails when `swap()` is missing, and it fails
 * silently: the test passes, the row is written outside the transaction, and
 * the next run finds it there.
 */
const available = await reachable('refresh-database')

const TABLE = 'refresh_probe'

for (const { name, config } of available) {
  describe(`refreshDatabase: ${name}`, () => {
    const app = new Application(process.cwd())
    app.config.set('database.default', name)
    app.config.set(`database.connections.${name}`, config)

    const db = new ConnectionManager(app)
    const manager = db as unknown as TestConnectionManager

    /**
     * Built once, outside any transaction, exactly as `migrate` is meant to be.
     *
     * SQLite's `:memory:` database belongs to its connection, so this has to run
     * against the same pooled connection the tests then wrap — which is what
     * `manager.connection()` gives it.
     */
    const migrate = async () => {
      const connection = await db.connection()

      await connection.unprepared(`drop table if exists ${TABLE}`)
      await connection.unprepared(
        `create table ${TABLE} (id integer, name varchar(60), deleted_at varchar(40) null)`
      )
    }

    refreshDatabase(manager, { beforeEach, afterEach }, { migrate })

    afterAll(async () => {
      forgetMigrations()
      await db.disconnectAll()
    })

    const insert = async (row: { id: number; name: string; deleted_at?: string | null }) => {
      const connection = await db.connection()
      const marks = connection.grammar.dialect === 'postgres' ? '$1, $2, $3' : '?, ?, ?'

      await connection.affectingStatement(
        `insert into ${TABLE} (id, name, deleted_at) values (${marks})`,
        [row.id, row.name, row.deleted_at ?? null]
      )
    }

    test('a row written in one test is not there in the next', async () => {
      await insert({ id: 1, name: 'first' })

      await assertDatabaseHas(manager, TABLE, { name: 'first' })
    })

    test('the previous test left nothing behind', async () => {
      await assertDatabaseCount(manager, TABLE, 0)
      await assertDatabaseMissing(manager, TABLE, { name: 'first' })
    })

    /**
     * The swap, proven rather than assumed.
     *
     * Resolving by name is what application code does — `db().connection()` in a
     * handler — and without `swap()` it answers with the pooled connection,
     * which is outside this test's transaction.
     */
    test('code that resolves the connection by name joins the test transaction', async () => {
      const resolved = await db.connection(name)

      expect(resolved.transactions).toBeDefined()

      await insert({ id: 2, name: 'by-name' })
      await assertDatabaseHas(manager, TABLE, { name: 'by-name' })
    })

    test('and that write is rolled back too', async () => {
      await assertDatabaseMissing(manager, TABLE, { name: 'by-name' })
    })

    test('null is matched with `is null`, not with `= null`', async () => {
      await insert({ id: 3, name: 'live', deleted_at: null })
      await insert({ id: 4, name: 'gone', deleted_at: '2026-01-01T00:00:00Z' })

      await assertDatabaseHas(manager, TABLE, { name: 'live', deleted_at: null })
      await assertDatabaseCount(manager, TABLE, 1, { deleted_at: null })
    })

    test('soft deletion is read off the column', async () => {
      await insert({ id: 5, name: 'live', deleted_at: null })
      await insert({ id: 6, name: 'gone', deleted_at: '2026-01-01T00:00:00Z' })

      await assertSoftDeleted(manager, TABLE, { name: 'gone' })
      await assertNotSoftDeleted(manager, TABLE, { name: 'live' })
    })

    test('a missing row says what the table does hold', async () => {
      await insert({ id: 7, name: 'actual' })

      const failure = await assertDatabaseHas(manager, TABLE, { name: 'expected' }).catch(
        (error: Error) => error.message
      )

      expect(failure).toContain('found none')
      expect(failure).toContain('actual')
    })

    test('an empty table says so', async () => {
      const failure = await assertDatabaseHas(manager, TABLE, { name: 'anything' }).catch(
        (error: Error) => error.message
      )

      expect(failure).toContain('is empty')
    })

    test('a failure inside the test is not swallowed by the rollback', async () => {
      // The rollback signal is a private symbol; a real error must still surface.
      const connection = await db.connection()

      await expect(connection.select('select * from a_table_that_is_not_there')).rejects.toThrow()
    })
  })
}

describe('quoting', () => {
  test('an identifier carrying a quote is refused rather than interpolated', async () => {
    const stub = {
      getDefaultConnection: () => 'sqlite',
      connection: async () => ({
        name: 'sqlite',
        grammar: { dialect: 'sqlite' },
        select: async () => [],
        transaction: async <T>(callback: (tx: never) => Promise<T>) => callback(undefined as never)
      }),
      swap: () => () => undefined
    } as unknown as TestConnectionManager

    await expect(assertDatabaseHas(stub, 'users"; drop table users; --', {})).rejects.toThrow(
      'contains a quote'
    )
  })
})
