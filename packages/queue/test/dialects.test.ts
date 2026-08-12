import { describe, expect, test } from 'bun:test'
import { Application } from '@elysian/core'
import { type ConnectionConfig, ConnectionManager } from '@elysian/database'
import type { JobPayload } from '../src/contracts.ts'
import { DatabaseQueue } from '../src/drivers/database.ts'

/**
 * The database driver against real servers.
 *
 * The reservation is the part that cannot be proved on SQLite alone: it depends on
 * `select … for update` inside a transaction, and SQLite serialises writes anyway,
 * so it would pass whether or not the lock were there. Postgres and MySQL are
 * where two workers can genuinely race for the same row.
 *
 * A server that is unreachable drops out with a note. Override with
 * TEST_POSTGRES_URL / TEST_MYSQL_URL.
 */

const PREFIX = `queue_t${Date.now().toString(36)}`
const TEST_DATABASE = 'elysian_test'

const candidates: Array<{ name: string; config: ConnectionConfig }> = [
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
          database: TEST_DATABASE
        }
  },
  {
    name: 'mysql',
    config: process.env.TEST_MYSQL_URL
      ? { driver: 'mysql', url: process.env.TEST_MYSQL_URL }
      : {
          driver: 'mysql',
          host: '127.0.0.1',
          port: 3309,
          username: 'root',
          database: TEST_DATABASE
        }
  }
]

const available: Array<{ name: string; config: ConnectionConfig }> = []

for (const candidate of candidates) {
  const app = new Application(process.cwd())
  app.config.set('database.default', candidate.name)
  app.config.set(`database.connections.${candidate.name}`, candidate.config)

  const db = new ConnectionManager(app)

  try {
    await (await db.connection()).select('select 1 as one')
    available.push(candidate)
  } catch (error) {
    console.log(
      `  skipping queue on ${candidate.name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 70)}`
    )
  } finally {
    await db.disconnectAll()
  }
}

test('sqlite is always part of the matrix', () => {
  expect(available.map((candidate) => candidate.name)).toContain('sqlite')
})

function payloadFor(label: string): JobPayload {
  return {
    uuid: crypto.randomUUID(),
    job: 'Probe',
    displayName: 'Probe',
    data: { label },
    attempts: 0,
    createdAt: Math.floor(Date.now() / 1000)
  }
}

for (const { name, config } of available) {
  describe(`queue on ${name}`, () => {
    const table = `${PREFIX}_jobs`

    test('reserving, releasing and recovering behave the same everywhere', async () => {
      const app = new Application(process.cwd())
      app.config.set('database.default', name)
      app.config.set(`database.connections.${name}`, config)

      const db = new ConnectionManager(app)
      const schema = await db.schema()

      await schema.create(table, (blueprint) => {
        blueprint.id()
        blueprint.string('queue')
        blueprint.text('payload')
        blueprint.integer('attempts')
        blueprint.integer('reserved_at').nullable()
        blueprint.integer('available_at')
        blueprint.integer('created_at')
      })

      try {
        /**
         * A long reservation window on purpose.
         *
         * `reserved_at` is a whole-second timestamp, so a one-second window can
         * report a reservation as expired a few milliseconds after it was taken —
         * the pops below then hand back the same row and the FIFO assertions fail
         * intermittently. Expiry is proved separately, by the driver underneath.
         */
        const driver = new DatabaseQueue(name, db, { table, retryAfter: 60 })

        await driver.push(payloadFor('first'))
        await driver.push(payloadFor('second'))

        expect(await driver.size()).toBe(2)

        // FIFO by id, and a reservation hides the row from the next pop.
        const first = await driver.pop()
        expect(first).not.toBeNull()
        expect((first?.payload.data as { label: string } | undefined)?.label).toBe('first')
        expect(first?.attempts()).toBe(1)

        const second = await driver.pop()
        expect((second?.payload.data as { label: string } | undefined)?.label).toBe('second')

        // Nothing left that is available.
        expect(await driver.pop()).toBeNull()

        // Releasing puts it back with the attempt count intact.
        await first?.release(0)
        const retried = await driver.pop()
        expect(retried?.attempts()).toBe(2)
        expect((retried?.payload.data as { label: string } | undefined)?.label).toBe('first')

        /**
         * A reservation that outlived its window comes back.
         *
         * Read through a second driver on the same table whose window has already
         * passed, rather than by sleeping: it asserts the same `reserved_at <= now
         * - retryAfter` branch without spending a second of wall clock on it.
         */
        const impatient = new DatabaseQueue(name, db, { table, retryAfter: 0 })
        const recovered = await impatient.pop()
        expect(recovered?.payload.uuid).toBe(second?.payload.uuid)
        expect(recovered?.attempts()).toBe(2)

        await recovered?.delete()
        await retried?.delete()
        expect(await driver.size()).toBe(0)

        // A delayed job stays out of reach until it is due.
        await driver.later(60, payloadFor('later'))
        expect(await driver.pop()).toBeNull()

        expect(await driver.size()).toBe(1)
        expect(await driver.clear()).toBe(1)
      } finally {
        await (await db.schema()).dropIfExists(table)
        await db.disconnectAll()
      }
    })

    /**
     * SQLite cannot take part: Bun opens one connection to it, so two concurrent
     * transactions are impossible ("cannot start a transaction within a
     * transaction"). It is also the one engine where the race cannot happen —
     * writers are serialised — so there is nothing to prove there.
     */
    test.skipIf(name === 'sqlite')('two workers racing for one job get it once', async () => {
      const app = new Application(process.cwd())
      app.config.set('database.default', name)
      app.config.set(`database.connections.${name}`, config)

      const db = new ConnectionManager(app)
      const schema = await db.schema()

      await schema.create(table, (blueprint) => {
        blueprint.id()
        blueprint.string('queue')
        blueprint.text('payload')
        blueprint.integer('attempts')
        blueprint.integer('reserved_at').nullable()
        blueprint.integer('available_at')
        blueprint.integer('created_at')
      })

      try {
        const driver = new DatabaseQueue(name, db, { table, retryAfter: 90 })

        await driver.push(payloadFor('contested'))

        // Both pops run concurrently against the same row. Without `for update`
        // inside the transaction they would both win it, and the job would run
        // twice — the failure this driver exists to prevent.
        const [left, right] = await Promise.all([driver.pop(), driver.pop()])

        const winners = [left, right].filter(Boolean)
        expect(winners.length).toBe(1)
        expect(winners[0]?.attempts()).toBe(1)
      } finally {
        await (await db.schema()).dropIfExists(table)
        await db.disconnectAll()
      }
    })
  })
}
