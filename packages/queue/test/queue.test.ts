import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elysian/core'
import { ConnectionManager } from '@elysian/database'
import type { JobPayload, QueueDriver } from '../src/contracts.ts'
import { DatabaseQueue } from '../src/drivers/database.ts'
import { RedisQueue } from '../src/drivers/redis.ts'
import { SyncQueue } from '../src/drivers/sync.ts'
import { ArrayFailedJobStore } from '../src/failed.ts'
import { Job, JobRegistry } from '../src/job.ts'
import { JobRunner } from '../src/runner.ts'
import { ModelRegistry, serializeData } from '../src/serializer.ts'
import { MaxAttemptsExceededError, Worker } from '../src/worker.ts'

/** Records what ran, so a test can assert on order and count. */
const ran: string[] = []

class Simple extends Job<{ label: string }> {
  async handle(): Promise<void> {
    ran.push(this.data.label)
  }
}

class Failing extends Job<{ label: string }> {
  static override tries = 3

  async handle(): Promise<void> {
    ran.push(`attempt:${this.attempts()}`)

    throw new Error('nope')
  }
}

class SelfDeleting extends Job<{ label: string }> {
  static override tries = 3

  async handle(): Promise<void> {
    ran.push('deleting')

    await this.deleteJob()
  }
}

class SelfReleasing extends Job<{ label: string }> {
  static override tries = 5

  async handle(): Promise<void> {
    ran.push('releasing')

    await this.releaseJob(0)
  }
}

class Slow extends Job<{ label: string }> {
  static override timeout = 1

  async handle(): Promise<void> {
    ran.push('slow:start')

    await Bun.sleep(3000)

    ran.push('slow:end')
  }
}

class WithFailedHook extends Job<{ label: string }> {
  static override tries = 1

  async handle(): Promise<void> {
    throw new Error('always')
  }

  override failed(error: unknown): void {
    ran.push(`failed-hook:${(error as Error).message}`)
  }
}

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

const registry = new JobRegistry().register(
  Simple,
  Failing,
  SelfDeleting,
  SelfReleasing,
  Slow,
  WithFailedHook
)

const models = new ModelRegistry()

function runnerFor(driver?: QueueDriver): JobRunner {
  return new JobRunner(registry, models, {
    chain: driver
      ? async (payload, _connection, queue) => {
          await driver.push(payload, queue)
        }
      : undefined
  })
}

// --------------------------------------------------------- driver conformance

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'

const redisAvailable = await (async () => {
  const driver = new RedisQueue('redis', { url: REDIS_URL, prefix: 'probe:' })

  try {
    await driver.size()
    return true
  } catch {
    console.log('  skipping redis queue: no server at', REDIS_URL)
    return false
  } finally {
    driver.disconnect()
  }
})()

type Candidate = {
  name: string
  make: () => Promise<{ driver: QueueDriver; dispose: () => Promise<void> }>
}

const candidates: Candidate[] = [
  {
    name: 'database',
    make: async () => {
      const app = new Application(process.cwd())
      app.config.set('database.default', 'queue-test')
      app.config.set('database.connections.queue-test', {
        driver: 'sqlite',
        database: ':memory:'
      })

      const db = new ConnectionManager(app)
      const schema = await db.schema()

      await schema.create('jobs', (table) => {
        table.id()
        table.string('queue')
        table.text('payload')
        table.integer('attempts')
        table.integer('reserved_at').nullable()
        table.integer('available_at')
        table.integer('created_at')
      })

      return {
        driver: new DatabaseQueue('database', db, { retryAfter: 1 }),
        dispose: () => db.disconnectAll()
      }
    }
  }
]

if (redisAvailable) {
  candidates.push({
    name: 'redis',
    make: async () => {
      const driver = new RedisQueue('redis', {
        url: REDIS_URL,
        prefix: `q${Date.now().toString(36)}:`,
        retryAfter: 1
      })

      return {
        driver,
        dispose: async () => {
          await driver.clear()
          driver.disconnect()
        }
      }
    }
  })
}

test('the database driver is always tested', () => {
  expect(candidates.map((candidate) => candidate.name)).toContain('database')
})

for (const candidate of candidates) {
  describe(`driver: ${candidate.name}`, () => {
    let driver: QueueDriver
    let dispose: () => Promise<void>

    beforeEach(async () => {
      ran.length = 0

      const made = await candidate.make()
      driver = made.driver
      dispose = made.dispose
    })

    afterEach(async () => {
      await dispose()
    })

    test('a pushed job comes back, once', async () => {
      await driver.push(payloadFor('Simple', { label: 'a' }))

      const job = await driver.pop()
      expect(job?.payload.job).toBe('Simple')
      // It is reserved now, so a second worker must not get it.
      expect(await driver.pop()).toBeNull()

      await job?.delete()
      expect(await driver.size()).toBe(0)
    })

    test('attempts increase with each reservation', async () => {
      await driver.push(payloadFor('Simple'))

      const first = await driver.pop()
      expect(first?.attempts()).toBe(1)

      await first?.release(0)

      const second = await driver.pop()
      expect(second?.attempts()).toBe(2)
    })

    test('a delayed job is not available yet', async () => {
      await driver.later(60, payloadFor('Simple'))

      expect(await driver.pop()).toBeNull()
      // Still counted: it is queued, just not ready.
      expect(await driver.size()).toBe(1)
    })

    test('a released job with a delay waits for it', async () => {
      await driver.push(payloadFor('Simple'))

      const job = await driver.pop()
      await job?.release(60)

      expect(await driver.pop()).toBeNull()
    })

    test('an expired reservation is picked up again', async () => {
      await driver.push(payloadFor('Simple'))

      const abandoned = await driver.pop()
      expect(abandoned).not.toBeNull()

      // The worker holding it "dies" — nothing releases the job.
      await Bun.sleep(1200)

      const recovered = await driver.pop()
      expect(recovered?.payload.uuid).toBe(abandoned?.payload.uuid)
      // The retry counts: it is the second time this payload has been reserved.
      expect(recovered?.attempts()).toBe(2)
    })

    test('queues are independent, and popped in the order asked for', async () => {
      await driver.push(payloadFor('Simple', { label: 'low' }), 'low')
      await driver.push(payloadFor('Simple', { label: 'high' }), 'high')

      expect(await driver.pop('default')).toBeNull()

      const worker = new Worker(driver, runnerFor(driver), new ArrayFailedJobStore())

      // Priority is expressed by the order of the names.
      await worker.runNextJob('high,low', { maxTries: 1 })
      await worker.runNextJob('high,low', { maxTries: 1 })

      expect(ran).toEqual(['high', 'low'])
    })

    test('clear empties a queue and reports how much it removed', async () => {
      await driver.push(payloadFor('Simple'))
      await driver.later(60, payloadFor('Simple'))

      expect(await driver.clear()).toBe(2)
      expect(await driver.size()).toBe(0)
    })

    test('a job runs through the worker and is removed', async () => {
      await driver.push(payloadFor('Simple', { label: 'worked' }))

      const worker = new Worker(driver, runnerFor(driver), new ArrayFailedJobStore())

      expect(await worker.runNextJob(undefined, { maxTries: 1 })).toBe('processed')
      expect(ran).toEqual(['worked'])
      expect(await driver.size()).toBe(0)
    })

    test('a failing job is retried up to its limit, then recorded as failed', async () => {
      const failed = new ArrayFailedJobStore()
      const worker = new Worker(driver, runnerFor(driver), failed)

      await driver.push({ ...payloadFor('Failing'), maxTries: 3 })

      expect(await worker.runNextJob(undefined, { maxTries: 3 })).toBe('released')
      expect(await worker.runNextJob(undefined, { maxTries: 3 })).toBe('released')
      // Third attempt is the last one allowed, so it fails instead of releasing.
      expect(await worker.runNextJob(undefined, { maxTries: 3 })).toBe('failed')

      expect(ran).toEqual(['attempt:1', 'attempt:2', 'attempt:3'])
      expect((await failed.all()).length).toBe(1)
      expect(await driver.size()).toBe(0)
    })

    test('a chain runs in order, one link at a time', async () => {
      const worker = new Worker(driver, runnerFor(driver), new ArrayFailedJobStore())

      await driver.push({
        ...payloadFor('Simple', { label: 'first' }),
        chain: [payloadFor('Simple', { label: 'second' }), payloadFor('Simple', { label: 'third' })]
      })

      // Each `runNextJob` handles one link; the next is queued by its success.
      await worker.runNextJob(undefined, { maxTries: 1 })
      expect(ran).toEqual(['first'])

      await worker.runNextJob(undefined, { maxTries: 1 })
      await worker.runNextJob(undefined, { maxTries: 1 })

      expect(ran).toEqual(['first', 'second', 'third'])
      expect(await driver.size()).toBe(0)
    })

    test('a chain stops when a link fails', async () => {
      const worker = new Worker(driver, runnerFor(driver), new ArrayFailedJobStore())

      await driver.push({
        ...payloadFor('Failing'),
        maxTries: 1,
        chain: [payloadFor('Simple', { label: 'never' })]
      })

      expect(await worker.runNextJob(undefined, { maxTries: 1 })).toBe('failed')
      expect(ran).toEqual(['attempt:1'])
      // The rest of the chain was never queued.
      expect(await driver.size()).toBe(0)
    })
  })
}

// ------------------------------------------------------------- worker policy

describe('Worker', () => {
  let db: ConnectionManager
  let driver: DatabaseQueue
  let failed: ArrayFailedJobStore

  beforeEach(async () => {
    ran.length = 0

    const app = new Application(process.cwd())
    app.config.set('database.default', 'worker-test')
    app.config.set('database.connections.worker-test', { driver: 'sqlite', database: ':memory:' })

    db = new ConnectionManager(app)
    const schema = await db.schema()

    await schema.create('jobs', (table) => {
      table.id()
      table.string('queue')
      table.text('payload')
      table.integer('attempts')
      table.integer('reserved_at').nullable()
      table.integer('available_at')
      table.integer('created_at')
    })

    driver = new DatabaseQueue('database', db, { retryAfter: 90 })
    failed = new ArrayFailedJobStore()
  })

  afterEach(async () => {
    await db.disconnectAll()
  })

  const worker = () => new Worker(driver, runnerFor(driver), failed)

  test('a job that deletes itself is not released', async () => {
    await driver.push({ ...payloadFor('SelfDeleting'), maxTries: 3 })

    expect(await worker().runNextJob(undefined, { maxTries: 3 })).toBe('processed')
    expect(ran).toEqual(['deleting'])
    expect(await driver.size()).toBe(0)
  })

  test('a job that releases itself is not released twice', async () => {
    await driver.push({ ...payloadFor('SelfReleasing'), maxTries: 5 })

    // Reported as released, because it was — by the job, not by the worker.
    expect(await worker().runNextJob(undefined, { maxTries: 5 })).toBe('released')
    // One row, back on the queue: had the worker released it too there would be
    // two copies of the same job waiting.
    expect(await driver.size()).toBe(1)
    expect(ran).toEqual(['releasing'])
  })

  test('a payload already past its attempts fails before it runs', async () => {
    // What a job that keeps timing out looks like: the count is high and nothing
    // ever threw, so the pre-flight check is the only place it can be caught.
    // The count has to be built up by reserving, not passed in: a fresh push
    // always starts at zero, which is what makes the count trustworthy.
    await driver.push({ ...payloadFor('SelfReleasing'), maxTries: 2 })

    await worker().runNextJob(undefined, { maxTries: 2 })
    await worker().runNextJob(undefined, { maxTries: 2 })
    ran.length = 0

    expect(await worker().runNextJob(undefined, { maxTries: 2 })).toBe('failed')
    // It never ran a third time.
    expect(ran).toEqual([])

    const records = await failed.all()
    expect(records[0]?.exception).toContain(MaxAttemptsExceededError.name)
  })

  test('retryUntil outranks the attempt count', async () => {
    const past = Math.floor(Date.now() / 1000) - 10

    await driver.push({ ...payloadFor('Failing'), maxTries: 0, retryUntil: past })

    expect(await worker().runNextJob(undefined, { maxTries: 0 })).toBe('failed')
  })

  test('a deadline in the future keeps an unlimited job alive', async () => {
    const future = Math.floor(Date.now() / 1000) + 60

    await driver.push({ ...payloadFor('Failing'), maxTries: 0, retryUntil: future })

    expect(await worker().runNextJob(undefined, { maxTries: 0 })).toBe('released')
  })

  test('a list backoff is indexed by attempt, then held', async () => {
    await driver.push({ ...payloadFor('Failing'), maxTries: 5, backoff: [10, 20] })

    // The row is re-inserted with `available_at` in the future; reading it back is
    // how the chosen backoff is observable.
    await worker().runNextJob(undefined, { maxTries: 5 })

    const first = await (await db.table('jobs')).first()
    const firstDelay = Number(first?.available_at) - Number(first?.created_at)
    expect(firstDelay).toBeGreaterThanOrEqual(10)
    expect(firstDelay).toBeLessThan(20)
  })

  test('the failed hook runs, and the job is recorded', async () => {
    await driver.push({ ...payloadFor('WithFailedHook'), maxTries: 1 })

    expect(await worker().runNextJob(undefined, { maxTries: 1 })).toBe('failed')
    expect(ran).toEqual(['failed-hook:always'])
    expect((await failed.all()).length).toBe(1)
  })

  test('an attempt that outlives its timeout is abandoned and retried', async () => {
    await driver.push({ ...payloadFor('Slow'), maxTries: 2, timeout: 1 })

    const outcome = await worker().runNextJob(undefined, { maxTries: 2, timeout: 1 })

    expect(outcome).toBe('released')
    // Started but never finished: the worker stopped waiting for it.
    expect(ran).toEqual(['slow:start'])
  })

  test('work() stops when the queue is empty', async () => {
    await driver.push(payloadFor('Simple', { label: 'only' }))

    const result = await worker().work(undefined, { maxTries: 1, stopWhenEmpty: true, sleep: 0 })

    expect(result).toMatchObject({ processed: 1, failed: 0, released: 0, reason: 'empty' })
  })

  test('work() stops after maxJobs', async () => {
    for (let index = 0; index < 3; index += 1) {
      await driver.push(payloadFor('Simple', { label: `job-${index}` }))
    }

    const result = await worker().work(undefined, { maxTries: 1, maxJobs: 2, sleep: 0 })

    expect(result.processed).toBe(2)
    expect(result.reason).toBe('max-jobs')
    expect(await driver.size()).toBe(1)
  })

  test('a worker asked to stop finishes the job in hand', async () => {
    await driver.push(payloadFor('Simple', { label: 'last' }))

    const instance = worker()
    const working = instance.work(undefined, { maxTries: 1, sleep: 0 })

    instance.stop()

    const result = await working
    expect(result.reason).toBe('stopped')
    // Whatever it had already reserved was seen through.
    expect(await driver.size()).toBe(0)
  })

  test('events report the lifecycle', async () => {
    const seen: string[] = []
    const events = { dispatch: (event: string) => seen.push(event) }

    await driver.push({ ...payloadFor('Failing'), maxTries: 1 })

    const instance = new Worker(driver, runnerFor(driver), failed, events)
    await instance.runNextJob(undefined, { maxTries: 1 })

    expect(seen).toEqual(['queue.job.processing', 'queue.job.exception', 'queue.job.failed'])
  })
})

// -------------------------------------------------------------- sync + runner

describe('SyncQueue', () => {
  beforeEach(() => {
    ran.length = 0
  })

  test('the job runs inside push, before the dispatcher returns', async () => {
    const driver = new SyncQueue('sync', (job) => runnerFor().run(job))

    await driver.push(payloadFor('Simple', { label: 'now' }))

    expect(ran).toEqual(['now'])
  })

  test('a delay does not wait, because there is nothing to wait in', async () => {
    const driver = new SyncQueue('sync', (job) => runnerFor().run(job))

    const started = Date.now()
    await driver.later(60, payloadFor('Simple', { label: 'immediate' }))

    expect(ran).toEqual(['immediate'])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('a failing job throws into the caller', async () => {
    const driver = new SyncQueue('sync', (job) => runnerFor().run(job))

    await expect(driver.push(payloadFor('Failing'))).rejects.toThrow('nope')
  })

  test('the queue is always empty', async () => {
    const driver = new SyncQueue('sync', (job) => runnerFor().run(job))

    expect(await driver.pop()).toBeNull()
    expect(await driver.size()).toBe(0)
  })
})

describe('JobRunner', () => {
  beforeEach(() => {
    ran.length = 0
  })

  test('an unregistered job says what to do about it', async () => {
    const driver = new SyncQueue('sync', (job) => runnerFor().run(job))

    await expect(driver.push(payloadFor('NotRegistered'))).rejects.toThrow(
      /is not registered.*app\/Jobs/s
    )
  })

  test('middleware wraps handle, outermost first', async () => {
    const order: string[] = []

    class Wrapped extends Job<{ label: string }> {
      override middleware() {
        return [
          {
            handle: async (_job: Job, next: () => Promise<void>) => {
              order.push('outer:before')
              await next()
              order.push('outer:after')
            }
          },
          {
            handle: async (_job: Job, next: () => Promise<void>) => {
              order.push('inner:before')
              await next()
              order.push('inner:after')
            }
          }
        ]
      }

      async handle(): Promise<void> {
        order.push('handle')
      }
    }

    const registered = new JobRegistry().register(Wrapped)
    const runner = new JobRunner(registered, models)
    const driver = new SyncQueue('sync', (job) => runner.run(job))

    await driver.push(payloadFor('Wrapped'))

    expect(order).toEqual(['outer:before', 'inner:before', 'handle', 'inner:after', 'outer:after'])
  })

  test('middleware that does not call next stops the job', async () => {
    let handled = false

    class Skipped extends Job<Record<string, never>> {
      override middleware() {
        return [{ handle: async (job: Job) => job.deleteJob() }]
      }

      async handle(): Promise<void> {
        handled = true
      }
    }

    const runner = new JobRunner(new JobRegistry().register(Skipped), models)
    const driver = new SyncQueue('sync', (job) => runner.run(job))

    await driver.push(payloadFor('Skipped'))

    expect(handled).toBe(false)
  })
})

// -------------------------------------------------------------- serialisation

describe('serializeData', () => {
  test('plain data passes through untouched', () => {
    const data = { id: 1, tags: ['a'], nested: { ok: true }, nothing: null }

    expect(serializeData(data)).toEqual(data)
  })

  test('a Date survives the round trip as a Date', async () => {
    const when = new Date('2026-08-12T10:00:00.000Z')
    const encoded = serializeData({ when })

    expect(encoded).toEqual({ when: { __date: '2026-08-12T10:00:00.000Z' } })

    const { deserializeData } = await import('../src/serializer.ts')
    const decoded = (await deserializeData(encoded, models)) as { when: Date }

    expect(decoded.when).toBeInstanceOf(Date)
    expect(decoded.when.getTime()).toBe(when.getTime())
  })

  test('an unregistered model reference explains how to register it', async () => {
    const { deserializeData } = await import('../src/serializer.ts')

    await expect(
      deserializeData({ article: { __model: 'Article', key: 1 } }, new ModelRegistry())
    ).rejects.toThrow(/not registered with the queue/)
  })
})
