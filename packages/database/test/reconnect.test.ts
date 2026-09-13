import { describe, expect, test } from 'bun:test'
import { reachable } from '../../../tests/support/dialects.ts'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'

/**
 * A connection the server closed underneath us.
 *
 * `Bun.SQL` is a pool and recovers on its own, so nothing here detects or
 * repairs a dropped connection. A queue worker depends on that entirely — it
 * holds one connection for its whole life and MySQL closes an idle one — and
 * nothing else in the suite would notice if a Bun release changed it.
 *
 * Killed from a second connection rather than simulated: a hand-written error
 * would only prove a message list matches itself. SQLite has no connection to
 * lose.
 */
const available = (await reachable('reconnect')).filter((candidate) => candidate.name !== 'sqlite')

if (available.length === 0) {
  test.skip('no networked database reachable, so reconnection is unproven', () => undefined)
}

for (const { name, config } of available) {
  describe(`reconnect: ${name}`, () => {
    // One connection, so the backend we kill is the one the next query uses.
    // A larger pool would hand out a healthy connection and prove nothing.
    const pinned = { ...config, max: 1 }

    /** Ask the server which of its backends is serving us. */
    const backendId = async (connection: BunSqlConnection): Promise<number> => {
      const column = name === 'postgres' ? 'pg_backend_pid()' : 'connection_id()'
      const rows = await connection.select<Record<string, unknown>>(`select ${column} as id`)

      return Number(Object.values(rows[0] as Record<string, unknown>)[0])
    }

    /** Kill it from somewhere else, the way the server itself would. */
    const kill = async (id: number): Promise<void> => {
      const executioner = await BunSqlConnection.make(`${name}-killer`, pinned)

      try {
        if (name === 'postgres') {
          await executioner.select('select pg_terminate_backend($1)', [id])
        } else {
          await executioner.unprepared(`KILL ${id}`)
        }
      } finally {
        await executioner.disconnect()
      }

      // MySQL's KILL is asynchronous: without this the next query sometimes
      // lands before the socket closes.
      await Bun.sleep(120)
    }

    test('a query on a killed connection reconnects and answers', async () => {
      const connection = await BunSqlConnection.make(name, pinned)

      try {
        const before = await backendId(connection)

        await kill(before)

        const rows = await connection.select<{ answer: number }>('select 1 as answer')
        expect(Number(rows[0]?.answer)).toBe(1)

        // Proof it is a different backend, not the same socket recovering.
        expect(await backendId(connection)).not.toBe(before)
      } finally {
        await connection.disconnect()
      }
    })

    test('a write on a killed connection lands exactly once', async () => {
      const connection = await BunSqlConnection.make(name, pinned)
      const table = 'reconnect_probe'

      try {
        await connection.unprepared(`drop table if exists ${table}`)
        await connection.unprepared(`create table ${table} (note varchar(40))`)

        await kill(await backendId(connection))

        const marks = name === 'postgres' ? '$1' : '?'
        await connection.affectingStatement(`insert into ${table} (note) values (${marks})`, [
          'after the kill'
        ])

        const rows = await connection.select<{ note: string }>(`select note from ${table}`)
        expect(rows).toHaveLength(1)
      } finally {
        await connection.unprepared(`drop table if exists ${table}`).catch(() => undefined)
        await connection.disconnect()
      }
    })

    /**
     * The rule that matters most: a lost connection took the transaction with
     * it, so carrying on against a fresh one would run the rest of the unit of
     * work outside the transaction the caller believes is open.
     */
    test('a killed connection inside a transaction throws rather than carrying on', async () => {
      const connection = await BunSqlConnection.make(name, pinned)

      try {
        const failure = await connection
          .transaction(async (tx) => {
            const id = await backendId(tx as BunSqlConnection)

            await kill(id)

            return tx.select('select 1 as answer')
          })
          .then(() => null)
          .catch((error: Error) => error)

        expect(failure).toBeInstanceOf(Error)
      } finally {
        await connection.disconnect()
      }
    })

    test('an ordinary error is not mistaken for a lost connection', async () => {
      const connection = await BunSqlConnection.make(name, pinned)

      try {
        await expect(connection.select('select * from a_table_that_is_not_there')).rejects.toThrow()
      } finally {
        await connection.disconnect()
      }
    })
  })
}
