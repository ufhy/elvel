import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { reachable } from '../../../tests/support/dialects.ts'
import { DatabaseBatchRepository } from '../src/batch.ts'
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

const available = await reachable('queue')

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

    test('batch counters agree on every dialect', async () => {
      const app = new Application(process.cwd())
      app.config.set('database.default', name)
      app.config.set(`database.connections.${name}`, config)

      const db = new ConnectionManager(app)
      app.instance('db', db as never)

      const batchTable = `${PREFIX}_job_batches`
      const schema = await db.schema()

      await schema.dropIfExists(batchTable)
      await schema.create(batchTable, (blueprint) => {
        blueprint.string('id').primary()
        blueprint.string('name')
        blueprint.integer('total_jobs')
        blueprint.integer('pending_jobs')
        blueprint.integer('failed_jobs')
        blueprint.text('failed_job_ids')
        blueprint.text('options').nullable()
        blueprint.integer('cancelled_at').nullable()
        blueprint.integer('created_at')
        blueprint.integer('finished_at').nullable()
      })

      try {
        const batches = new DatabaseBatchRepository(app as never, batchTable, name)

        const stored = await batches.store({
          id: `batch-${name}`,
          name: 'import',
          totalJobs: 2,
          pendingJobs: 2,
          failedJobs: 0,
          failedJobIds: [],
          options: { allowFailures: true },
          createdAt: Math.floor(Date.now() / 1000)
        })

        // A decrement, a JSON column and a conditional `update ... where finished_at
        // is null` — three things a dialect can quietly disagree about.
        const afterSuccess = await batches.recordSuccess(stored.id, 'job-1')
        expect(afterSuccess?.pendingJobs).toBe(1)
        expect(afterSuccess?.finished).toBe(false)

        const afterFailure = await batches.recordFailure(stored.id, 'job-2')
        expect(afterFailure?.pendingJobs).toBe(0)
        expect(afterFailure?.failedJobs).toBe(1)
        expect(afterFailure?.record.failedJobIds).toEqual(['job-2'])
        // Nothing pending, so it is finished — and stamped once.
        expect(afterFailure?.finished).toBe(true)

        const stamp = afterFailure?.record.finishedAt
        expect((await batches.recordSuccess(stored.id, 'job-3'))?.record.finishedAt).toBe(
          stamp as number
        )

        await batches.cancel(stored.id)
        expect((await batches.find(stored.id))?.cancelled).toBe(true)

        /**
         * The three sweeps, on a real server, with fixtures of their own.
         *
         * Not reusing the batch above: it was finished *and then* cancelled, so
         * `prune` is entitled to it — which is exactly the overlap that makes a
         * shared fixture prove nothing about which predicate matched.
         *
         * Ages use a negative window, meaning "older than the future": everything
         * qualifies, so what is under test is the predicate rather than the clock.
         */
        const at = Math.floor(Date.now() / 1000)

        // Clear what the assertions above left behind — that batch was finished
        // *and* cancelled, and counting it here would prove nothing about which
        // predicate matched.
        await batches.prune(-1)

        const fixture = async (id: string, extra: Record<string, unknown>) =>
          batches.store({
            id: `${id}-${name}`,
            name: id,
            totalJobs: 1,
            pendingJobs: 1,
            failedJobs: 0,
            failedJobIds: [],
            options: {},
            createdAt: at,
            ...extra
          })

        const done = await fixture('done', { pendingJobs: 0, finishedAt: at })
        const stalled = await fixture('stalled', {})
        const abandoned = await fixture('abandoned', { cancelledAt: at })

        // Finished only: the other two are untouched.
        expect(await batches.prune(-1)).toBe(1)
        expect(await batches.find(done.id)).toBeUndefined()
        expect(await batches.find(stalled.id)).toBeDefined()
        expect(await batches.find(abandoned.id)).toBeDefined()

        // A cancelled batch never finishes by design, so `prune` would keep it
        // for ever — this is the sweep that exists for it.
        expect(await batches.pruneCancelled(-1)).toBe(1)
        expect(await batches.find(abandoned.id)).toBeUndefined()
        expect(await batches.find(stalled.id)).toBeDefined()

        expect(await batches.pruneUnfinished(-1)).toBe(1)
        expect(await batches.find(stalled.id)).toBeUndefined()
      } finally {
        await (await db.schema()).dropIfExists(batchTable)
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
