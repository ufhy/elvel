import { describe, expect, test } from 'bun:test'
import { reachable } from '../../../tests/support/dialects.ts'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'

/**
 * A connection the server closed underneath us.
 *
 * **`Bun.SQL` recovers from this on its own**, and this file exists to hold it
 * to that. It is a pool, not a single connection: a backend that has gone is
 * discarded and the next query opens a fresh one, so the framework needs no
 * equivalent of Laravel's `DetectsLostConnections` — which exists because PDO
 * holds one connection and cannot.
 *
 * That is a behaviour the queue depends on completely. A worker holds a
 * connection for its whole life, and MySQL closes an idle one after
 * `wait_timeout`; if this ever stopped being true, every job after the first
 * idle period would fail and nothing else in the suite would notice.
 *
 * Killed from a second connection rather than simulated: a hand-written error
 * would only prove that a message list matches itself. `pg_terminate_backend`
 * and MySQL's `KILL` do to a connection exactly what `wait_timeout` does.
 *
 * SQLite is not in this matrix and cannot be: there is no connection to lose.
 */
const available = (await reachable('reconnect')).filter((candidate) => candidate.name !== 'sqlite')

if (available.length === 0) {
  test.skip('no networked database reachable, so reconnection is unproven', () => undefined)
}

for (const { name, config } of available) {
  describe(`reconnect: ${name}`, () => {
    /**
     * One connection in the pool, so the backend we kill is the backend the next
     * query uses. With the default pool size the query could be handed a
     * different, healthy connection and the test would pass without proving
     * anything.
     */
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

      // MySQL's KILL is asynchronous: the server marks the thread and closes the
      // socket a moment later. Without this the next query sometimes lands
      // before the close and the connection was never actually lost.
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
     * The rule that matters most, and the reason the recovery above must not be
     * extended to transactions: a lost connection took the transaction with it,
     * so carrying on against a fresh one would run the rest of the unit of work
     * *outside* the transaction the caller still believes is open — and the
     * rollback would not undo what had already been written.
     *
     * The pool does the right thing here and the test pins it.
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
