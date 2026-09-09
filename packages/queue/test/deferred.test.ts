import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Application, defer, deferredCount, requestSlot } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import type { JobPayload, QueueDriver } from '../src/contracts.ts'
import { DatabaseQueue } from '../src/drivers/database.ts'
import { ArrayFailedJobStore } from '../src/failed.ts'
import { Job, JobRegistry } from '../src/job.ts'
import { JobRunner } from '../src/runner.ts'
import { ModelRegistry } from '../src/serializer.ts'
import { Worker } from '../src/worker.ts'

/**
 * A job is a unit of work, so it gets a context and a deferred queue of its own.
 *
 * It had neither. `enterDeferredScope` and `flushDeferred` each had exactly one
 * caller in the workspace — the http layer — so `defer()` inside a job pushed
 * onto the process-wide array that nothing drains: the callback never ran, and a
 * long-lived worker accumulated them for the life of the process. On the `sync`
 * connection the job runs inside a request and the http layer flushed it into
 * the *request's* queue, which made `defer()` behave differently depending on
 * which queue driver was configured.
 *
 * And without a context of its own, two jobs a worker runs in sequence shared
 * whatever the loop was in — the leak fixed for requests in #9 and still open
 * for jobs.
 */

/** What the deferred callbacks recorded, in the order they ran. */
const flushed: string[] = []

/** A slot, to watch whether one job can see another's. */
const marker = requestSlot<string>('job-marker')

class Deferring extends Job<{ label: string }> {
  async handle(): Promise<void> {
    defer(() => {
      flushed.push(`deferred:${this.data.label}`)
    })
  }
}

class DeferringAndFailing extends Job<{ label: string }> {
  static override tries = 1

  async handle(): Promise<void> {
    defer(() => {
      flushed.push(`deferred:${this.data.label}`)
    })

    throw new Error('nope')
  }
}

/** Reads the slot, then writes it — so a leak shows up as a non-empty read. */
class Marking extends Job<{ label: string }> {
  async handle(): Promise<void> {
    flushed.push(`saw:${marker.get() ?? 'nothing'}`)
    marker.set(this.data.label)
  }
}

/** How many callbacks the job left in the queue nobody drains. */
class Counting extends Job<{ label: string }> {
  async handle(): Promise<void> {
    defer(() => undefined)

    flushed.push(`count:${deferredCount()}`)
  }
}

const registry = new JobRegistry().register(Deferring, DeferringAndFailing, Marking, Counting)

function payloadFor(job: string, data: Record<string, unknown> = {}): JobPayload {
  return {
    uuid: crypto.randomUUID(),
    job,
    displayName: job,
    data,
    attempts: 0,
    createdAt: Math.floor(Date.now() / 1000)
  }
}

describe('deferred work in a queued job', () => {
  let db: ConnectionManager
  let driver: QueueDriver

  beforeEach(async () => {
    flushed.length = 0

    const app = new Application(process.cwd())
    app.config.set('database.default', 'deferred-test')
    app.config.set('database.connections.deferred-test', {
      driver: 'sqlite',
      database: ':memory:'
    })

    db = new ConnectionManager(app)

    await (await db.schema()).create('jobs', (table) => {
      table.id()
      table.string('queue')
      table.text('payload')
      table.integer('attempts')
      table.integer('reserved_at').nullable()
      table.integer('available_at')
      table.integer('created_at')
    })

    driver = new DatabaseQueue('database', db, { retryAfter: 90 })
  })

  afterEach(async () => {
    await db.disconnectAll()
  })

  const worker = (): Worker =>
    new Worker(driver, new JobRunner(registry, new ModelRegistry()), new ArrayFailedJobStore())

  test('runs when the job finishes', async () => {
    await driver.push(payloadFor('Deferring', { label: 'one' }))

    expect<string>(await worker().runNextJob(undefined, { maxTries: 1 })).toBe('processed')
    expect<string[]>(flushed).toEqual(['deferred:one'])
  })

  /**
   * A job that failed still deferred what it deferred.
   *
   * Dropping that work because the job threw is a second failure hidden behind
   * the first, which is why the flush is in a `finally` rather than on the way
   * out of the success path.
   */
  test('runs even when the job fails', async () => {
    await driver.push(payloadFor('DeferringAndFailing', { label: 'doomed' }))

    await worker().runNextJob(undefined, { maxTries: 1 })

    expect<string[]>(flushed).toEqual(['deferred:doomed'])
  })

  test('belongs to its own job, not to the one before it', async () => {
    await driver.push(payloadFor('Deferring', { label: 'first' }))
    await driver.push(payloadFor('Deferring', { label: 'second' }))

    const running = worker()

    await running.runNextJob(undefined, { maxTries: 1 })
    await running.runNextJob(undefined, { maxTries: 1 })

    // Two flushes of one callback each, not one flush of two.
    expect<string[]>(flushed).toEqual(['deferred:first', 'deferred:second'])
  })

  /**
   * The queue a job defers into holds only its own.
   *
   * Without a scope per job the count grew — every `defer()` from every job
   * stacking up in the process-wide array — so the second job would have seen 2.
   */
  test('starts each job with an empty queue', async () => {
    await driver.push(payloadFor('Counting', { label: 'a' }))
    await driver.push(payloadFor('Counting', { label: 'b' }))

    const running = worker()

    await running.runNextJob(undefined, { maxTries: 1 })
    await running.runNextJob(undefined, { maxTries: 1 })

    expect<string[]>(flushed).toEqual(['count:1', 'count:1'])
  })

  /**
   * The same isolation for every other slot — guarded, not demonstrated.
   *
   * Unlike the four above, this one **passes against the unfixed worker too**:
   * with no context opened per job, `set` enters one in the job's own async
   * branch and it happens not to reach the next job through this call shape. So
   * it is a regression guard for the property, not evidence that the property
   * was ever broken here — which is worth saying, because a test that passes
   * either way is easy to mistake for proof.
   *
   * Kept because the property is the one that matters most if it ever does
   * break: a session, a tenant, a signed-in user, whatever a package keeps in a
   * slot.
   */
  test('does not let one job see another’s slots', async () => {
    await driver.push(payloadFor('Marking', { label: 'first' }))
    await driver.push(payloadFor('Marking', { label: 'second' }))

    const running = worker()

    await running.runNextJob(undefined, { maxTries: 1 })
    await running.runNextJob(undefined, { maxTries: 1 })

    expect<string[]>(flushed).toEqual(['saw:nothing', 'saw:nothing'])
  })
})
