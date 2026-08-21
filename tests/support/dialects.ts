import { Application } from '@elvel/core'
import { BunSqlConnection, type ConnectionConfig, ConnectionManager } from '@elvel/database'

/**
 * The dialect matrix, in one place.
 *
 * Four suites ask the same three questions — is this server reachable, does our
 * test database exist, and what do I skip if not — and they had answered them
 * four times. Two of the copies got it wrong in the same way: they asked to
 * connect *to* `elvel_test` instead of creating it, so they only reached Postgres
 * and MySQL when the one suite that does create it happened to run first. In CI
 * it ran second, and both quietly skipped the servers they existed for. Coverage
 * that depends on file order is not coverage.
 *
 * Override the defaults with TEST_POSTGRES_URL / TEST_MYSQL_URL.
 */

export type Candidate = { name: string; config: ConnectionConfig }

/** Our own database on each server, never the maintenance one. */
export const TEST_DATABASE = 'elvel_test'

/**
 * Connecting to the maintenance database rather than to ours, because ours may
 * not exist yet — that is the whole point of `provision`.
 *
 * MySQL's `mysql` schema does not enforce InnoDB foreign keys, so a suite that
 * ran there silently passed rows a real application database rejects. Hence a
 * database of our own, and hence connecting somewhere else to create it.
 */
export function candidates(): Candidate[] {
  return [
    { name: 'sqlite', config: { driver: 'sqlite', database: ':memory:' } },
    {
      name: 'postgres',
      config: process.env.TEST_POSTGRES_URL
        ? { driver: 'postgres', url: process.env.TEST_POSTGRES_URL }
        : {
            driver: 'postgres',
            host: '127.0.0.1',
            port: 5432,
            username: 'postgres',
            database: 'postgres'
          }
    },
    {
      name: 'mysql',
      config: process.env.TEST_MYSQL_URL
        ? { driver: 'mysql', url: process.env.TEST_MYSQL_URL }
        : { driver: 'mysql', host: '127.0.0.1', port: 3309, username: 'root', database: 'mysql' }
    }
  ]
}

/** Create `elvel_test` if it is missing, and point the config at it. */
export async function provision(candidate: Candidate): Promise<Candidate> {
  if (candidate.config.driver === 'sqlite' || candidate.config.url) return candidate

  const admin = await BunSqlConnection.make(candidate.name, candidate.config)

  try {
    if (candidate.config.driver === 'postgres') {
      // Postgres has no CREATE DATABASE IF NOT EXISTS.
      const existing = await admin.select('select 1 as found from pg_database where datname = $1', [
        TEST_DATABASE
      ])

      if (existing.length === 0) await admin.unprepared(`create database ${TEST_DATABASE}`)
    } else {
      await admin.unprepared(`create database if not exists ${TEST_DATABASE}`)
    }
  } finally {
    await admin.disconnect()
  }

  return { name: candidate.name, config: { ...candidate.config, database: TEST_DATABASE } }
}

/**
 * Every dialect this machine can actually run, provisioned and proven with a
 * query. Anything unreachable drops out with a note naming the suite, so a log
 * says which coverage was lost rather than only that something was skipped.
 */
export async function reachable(label: string): Promise<Candidate[]> {
  const available: Candidate[] = []

  for (const candidate of candidates()) {
    try {
      const ready = await provision(candidate)

      const app = new Application(process.cwd())
      app.config.set('database.default', ready.name)
      app.config.set(`database.connections.${ready.name}`, ready.config)

      const db = new ConnectionManager(app)

      try {
        /**
         * Bounded, because an unreachable server is not the only failure.
         *
         * MySQL from Bun on Windows does not refuse and does not answer — it
         * hangs, and an unbounded `await` here took the whole suite with it: no
         * summary, no exit, nothing to read. A refusal is a sentence; a hang is
         * a mystery, and this file is the one place that can tell them apart.
         *
         * Five seconds is far longer than any of these probes needs — the same
         * three servers answer in milliseconds when they answer at all.
         */
        await Promise.race([
          (await db.connection()).select('select 1 as one'),
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error('no answer in 5s — it did not refuse, it hung')),
              5_000
            )
          })
        ])

        available.push(ready)
      } finally {
        await db.disconnectAll()
      }
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).slice(0, 70)

      console.log(`  skipping ${label} on ${candidate.name}: ${why}`)
    }
  }

  return available
}
