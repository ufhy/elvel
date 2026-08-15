#!/usr/bin/env bun
/**
 * Close the client connections the interrupted test runs left behind.
 *
 * Only *client* connections, and never this script's own: Postgres background
 * workers and MySQL's event scheduler are the server doing its job, and killing
 * those is how a dev database ends up needing a restart.
 */
import { BunSqlConnection } from '../packages/database/src/connection/bun-sql.ts'

const bounded = <T>(label: string, run: () => Promise<T>, ms = 8000): Promise<T | undefined> =>
  Promise.race([
    run(),
    new Promise<undefined>((resolve) =>
      setTimeout(() => {
        console.log(`  ${label}: tidak menjawab dalam ${ms / 1000}s`)
        resolve(undefined)
      }, ms)
    )
  ])

// ------------------------------------------------------------------ postgres

async function flushPostgres(): Promise<void> {
  console.log('\npostgres 127.0.0.1:5432')

  /**
   * `max: 1`, and that is not a detail.
   *
   * A Bun SQL connection is a **pool** — ten sockets by default. Left at the
   * default, this tool opens ten, excludes only the one it is asking through,
   * and then reports and kills the other nine as though they were somebody
   * else's. One socket makes the count honest.
   */
  const connection = await BunSqlConnection.make('flush', {
    driver: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'postgres',
    database: 'postgres',
    max: 1
  })

  try {
    const before = await bounded('daftar', () =>
      connection.select<{ pid: number; datname: string | null; state: string | null }>(
        `select pid, datname, state
           from pg_stat_activity
          where backend_type = 'client backend'
            and pid <> pg_backend_pid()`
      )
    )

    if (before === undefined) return

    console.log(`  koneksi klien: ${before.length}`)
    for (const row of before) {
      console.log(`    pid ${row.pid}  db=${row.datname ?? '-'}  state=${row.state ?? '-'}`)
    }

    if (before.length === 0) return

    const killed = await bounded('terminate', () =>
      connection.select<{ pid: number }>(
        `select pg_terminate_backend(pid) as pid
           from pg_stat_activity
          where backend_type = 'client backend'
            and pid <> pg_backend_pid()`
      )
    )

    console.log(`  ditutup: ${killed?.length ?? 0}`)
  } finally {
    await bounded('disconnect', () => connection.disconnect(), 5000)
  }
}

// --------------------------------------------------------------------- mysql

async function flushMysql(): Promise<void> {
  console.log('\nmysql 127.0.0.1:3309')

  // `max: 1` for the same reason as above: one socket, so the count is honest.
  const connection = await BunSqlConnection.make('flush', {
    driver: 'mysql',
    host: '127.0.0.1',
    port: 3309,
    username: 'root',
    database: 'mysql',
    max: 1
  })

  try {
    const before = await bounded('daftar', () =>
      connection.select<{ id: number; user: string; db: string | null; command: string }>(
        `select ID as id, USER as user, DB as db, COMMAND as command
           from information_schema.processlist
          where ID <> connection_id()
            and USER <> 'event_scheduler'`
      )
    )

    if (before === undefined) return

    console.log(`  koneksi klien: ${before.length}`)
    for (const row of before) {
      console.log(`    id ${row.id}  user=${row.user}  db=${row.db ?? '-'}  ${row.command}`)
    }

    let killed = 0

    for (const row of before) {
      // One at a time: MySQL has no set-based KILL, and a thread that has already
      // gone makes the statement fail rather than the whole sweep.
      const done = await bounded(
        `kill ${row.id}`,
        async () => {
          try {
            await connection.unprepared(`KILL ${row.id}`)
          } catch {
            // Already gone between the listing and the kill.
          }

          return true
        },
        4000
      )

      if (done) killed += 1
    }

    console.log(`  ditutup: ${killed}`)
  } finally {
    await bounded('disconnect', () => connection.disconnect(), 5000)
  }
}

for (const [label, run] of [
  ['postgres', flushPostgres],
  ['mysql', flushMysql]
] as Array<[string, () => Promise<void>]>) {
  try {
    await run()
  } catch (error) {
    console.log(`\n${label}: ${(error as Error).message.slice(0, 120)}`)
  }
}

console.log('\nselesai')

// The framework's own bug is that a connection may not close; exiting explicitly
// is the point of this script rather than something to be embarrassed about.
process.exit(0)
