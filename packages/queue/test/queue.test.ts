import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elysian/core'
import { ConnectionManager } from '@elysian/database'
import { EventRegistry, ListenerRegistry, QueuedListener } from '@elysian/events'
import { ArrayBatchRepository } from '../src/batch.ts'
import { PendingBatch } from '../src/bus.ts'
import type { JobPayload, QueueDriver } from '../src/contracts.ts'
import { DatabaseQueue } from '../src/drivers/database.ts'
import { RedisQueue } from '../src/drivers/redis.ts'
import { SyncQueue } from '../src/drivers/sync.ts'
import { ArrayFailedJobStore } from '../src/failed.ts'
import { type AnyJob, Job, JobRegistry } from '../src/job.ts'
import { CallQueuedListener, queuedListenerJob } from '../src/listener-job.ts'
import { QueueManager } from '../src/manager.ts'
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

describe('encrypted payloads', () => {
  /** The two methods the queue needs, standing in for the encryption package. */
  const encrypter = {
    encrypt: (value: unknown, context?: string) =>
      `enc:${Buffer.from(`${context ?? ''}|${JSON.stringify(value)}`).toString('base64url')}`,
    decrypt: <T>(payload: string, context?: string): T => {
      const decoded = Buffer.from(payload.slice(4), 'base64url').toString()
      const separator = decoded.indexOf('|')

      if (decoded.slice(0, separator) !== (context ?? '')) throw new Error('wrong context')

      return JSON.parse(decoded.slice(separator + 1)) as T
    }
  }

  class Confidential extends Job<{ token: string }> {
    static override encrypted = true

    async handle(): Promise<void> {
      ran.push(`token:${this.data.token}`)
    }
  }

  beforeEach(() => {
    ran.length = 0
  })

  test('the stored payload holds a ciphertext, and the job still runs', async () => {
    const stored: JobPayload = {
      ...payloadFor('Confidential'),
      encrypted: true,
      data: { __encrypted: encrypter.encrypt({ token: 'sk-live-123' }, 'job:Confidential') }
    }

    // Nothing readable in what the queue would keep.
    expect(JSON.stringify(stored)).not.toContain('sk-live-123')

    const runner = new JobRunner(new JobRegistry().register(Confidential), models, { encrypter })
    const driver = new SyncQueue('sync', (job) => runner.run(job))

    await driver.push(stored)

    expect(ran).toEqual(['token:sk-live-123'])
  })

  test('a payload encrypted for another job is refused', async () => {
    const stored: JobPayload = {
      ...payloadFor('Confidential'),
      encrypted: true,
      // Written for a different job: the context is what stops it running here.
      data: { __encrypted: encrypter.encrypt({ token: 'sk-live-123' }, 'job:SomethingElse') }
    }

    const runner = new JobRunner(new JobRegistry().register(Confidential), models, { encrypter })
    const driver = new SyncQueue('sync', (job) => runner.run(job))

    await expect(driver.push(stored)).rejects.toThrow(/wrong context/)
  })

  test('an encrypted payload with no encrypter says what to register', async () => {
    const stored: JobPayload = {
      ...payloadFor('Confidential'),
      encrypted: true,
      data: { __encrypted: 'enc:whatever' }
    }

    const runner = new JobRunner(new JobRegistry().register(Confidential), models)
    const driver = new SyncQueue('sync', (job) => runner.run(job))

    await expect(driver.push(stored)).rejects.toThrow(/EncryptionServiceProvider/)
  })

  test('a payload marked encrypted but carrying nothing is refused', async () => {
    const stored: JobPayload = {
      ...payloadFor('Confidential'),
      encrypted: true,
      data: {}
    }

    const runner = new JobRunner(new JobRegistry().register(Confidential), models, { encrypter })
    const driver = new SyncQueue('sync', (job) => runner.run(job))

    await expect(driver.push(stored)).rejects.toThrow(/carries no ciphertext/)
  })
})

// ------------------------------------------------------------ queued listeners

describe('queued listeners', () => {
  class OrderShipped {
    static readonly eventName = 'order.shipped'

    constructor(readonly orderId: number) {}

    label(): string {
      return `order-${this.orderId}`
    }
  }

  class RecordShipment extends QueuedListener<OrderShipped> {
    static override queue = 'notifications'
    static override tries = 5
    static override backoff = [1, 2]
    static seen: string[] = []
    static failures: string[] = []

    handle(event: OrderShipped): void {
      // Calling a method proves the event arrived as itself, not as loose data.
      RecordShipment.seen.push(event.label())
    }

    override failed(event: OrderShipped, error: unknown): void {
      RecordShipment.failures.push(`${event.label()}:${(error as Error).message}`)
    }
  }

  let listeners: ListenerRegistry
  let events: EventRegistry

  beforeEach(() => {
    RecordShipment.seen = []
    RecordShipment.failures = []

    listeners = new ListenerRegistry()
    listeners.register(RecordShipment as never)

    events = new EventRegistry()
    events.register(OrderShipped)

    CallQueuedListener.useRegistries(listeners, events)
  })

  const jobFor = (orderId: number) =>
    queuedListenerJob(RecordShipment as never, 'RecordShipment', {
      name: 'order.shipped',
      payload: new OrderShipped(orderId)
    })

  test('the listener’s options travel to the job', () => {
    const job = jobFor(1).constructor as typeof CallQueuedListener

    expect(job.queue).toBe('notifications')
    expect(job.tries).toBe(5)
    expect(job.backoff).toEqual([1, 2])
    // What `queue:failed` prints: the listener, not the wrapper.
    expect(job.displayName).toBe('RecordShipment')
  })

  test('two listeners queued in the same tick keep their own options', () => {
    class Impatient extends QueuedListener<OrderShipped> {
      static override tries = 1

      handle(): void {}
    }

    const first = jobFor(1).constructor as typeof CallQueuedListener
    const second = queuedListenerJob(Impatient as never, 'Impatient', {
      name: 'order.shipped',
      payload: new OrderShipped(2)
    }).constructor as typeof CallQueuedListener

    // The reason each gets its own subclass rather than mutating a shared one.
    expect(first.tries).toBe(5)
    expect(second.tries).toBe(1)
  })

  test('the worker resolves it under the wrapper’s name', () => {
    // A worker looks the payload's `job` up, so every listener has to arrive as
    // the same registered class however many subclasses were made.
    expect(jobFor(1).constructor.name).toBe('CallQueuedListener')
  })

  test('running it calls the listener with the event rebuilt', async () => {
    const job = jobFor(7)
    // Through JSON, as the store would: the worker never sees the object, and
    // `label()` only exists again because the event was rebuilt from its class.
    const payload = payloadFor(
      'CallQueuedListener',
      JSON.parse(JSON.stringify(job.data)) as Record<string, unknown>
    )
    const driver = new SyncQueue('sync', (queued) =>
      new JobRunner(new JobRegistry().register(CallQueuedListener as never), models, {}).run(queued)
    )

    await driver.push(payload)

    expect(RecordShipment.seen).toEqual(['order-7'])
  })

  test('a failure reaches the listener’s failed(), with the event', async () => {
    const job = jobFor(3)

    await job.failed(new Error('smtp down'))

    expect(RecordShipment.failures).toEqual(['order-3:smtp down'])
  })

  test('an unregistered listener says how to register it', async () => {
    listeners = new ListenerRegistry()
    CallQueuedListener.useRegistries(listeners, events)

    const job = jobFor(1)

    await expect(job.handle()).rejects.toThrow(/is not registered.*app\/Listeners/s)
  })
})

// ------------------------------------------------------------------- batches

describe('batches', () => {
  class Counted extends Job<{ label: string }> {
    static ran: string[] = []

    async handle(): Promise<void> {
      Counted.ran.push(this.data.label)
    }
  }

  class Breaks extends Job<{ label: string }> {
    static override tries = 1

    async handle(): Promise<void> {
      throw new Error(`${this.data.label} broke`)
    }
  }

  class Afterwards extends Job<{ batchId: string }> {
    static seen: string[] = []

    async handle(): Promise<void> {
      Afterwards.seen.push(`then:${this.data.batchId}`)
    }
  }

  class Rescue extends Job<{ batchId: string }> {
    static seen: string[] = []

    async handle(): Promise<void> {
      Rescue.seen.push(`catch:${this.data.batchId}`)
    }
  }

  let batches: ArrayBatchRepository
  let dispatched: Array<{ payload: JobPayload; queue: string }>

  /**
   * A stand-in that builds chain payloads the way the manager does.
   *
   * The batch id has to reach every link: the manager passes it down through
   * `payloadFor`, and a stub that forgot to would make the test pass for the
   * wrong reason.
   */
  function chainingDispatcher(driver?: { push(payload: JobPayload): Promise<unknown> }) {
    return {
      batches: () => batches,
      jobs: { has: () => true, register: () => undefined },
      dispatch: async (job: AnyJob, options: { batchId?: string; chain?: AnyJob[] }) => {
        const payload = payloadFor(job.constructor.name, { ...(job.data as object) })
        payload.batchId = options.batchId

        const chain = (options.chain ?? []).map((link) => {
          const linked = payloadFor(link.constructor.name, { ...(link.data as object) })
          linked.batchId = options.batchId

          return linked
        })

        if (chain.length > 0) payload.chain = chain

        dispatched.push({ payload, queue: 'default' })
        await driver?.push(payload)

        return payload.uuid
      }
    }
  }

  /** A manager-shaped stand-in: enough for PendingBatch, with no application. */
  function dispatcher() {
    return {
      batches: () => batches,
      jobs: { has: () => true, register: () => undefined },
      dispatch: async (job: AnyJob, options: { batchId?: string }) => {
        const payload = payloadFor(job.constructor.name, { ...(job.data as object) })
        payload.batchId = options.batchId
        dispatched.push({ payload, queue: 'default' })

        return payload.uuid
      }
    }
  }

  const registry = new JobRegistry().register(Counted, Breaks, Afterwards, Rescue)

  function runnerFor(driver: QueueDriver) {
    return new JobRunner(registry, new ModelRegistry(), {
      batches,
      chain: async (payload, _connection, queue) => {
        await driver.push(payload, queue)
      },
      dispatchCallback: async (job, batchId) => {
        // The id is data, not the payload's `batchId`: a callback counted as a
        // member of the batch it reports on finishes it a second time, for ever.
        await driver.push(payloadFor(job, { batchId }))
      }
    })
  }

  beforeEach(() => {
    batches = new ArrayBatchRepository()
    dispatched = []
    Counted.ran = []
    Afterwards.seen = []
    Rescue.seen = []
  })

  test('dispatching records the batch before queueing anything', async () => {
    const batch = await new PendingBatch(dispatcher() as never, [
      new Counted({ label: 'a' }),
      new Counted({ label: 'b' })
    ])
      .name('import')
      .dispatch()

    expect(batch.totalJobs).toBe(2)
    expect(batch.pendingJobs).toBe(2)
    expect(batch.progress).toBe(0)
    // Stored first: a worker fast enough to reserve job one before the row exists
    // would have nothing to count against.
    expect(await batches.find(batch.id)).toBeDefined()
    expect(dispatched).toHaveLength(2)
    expect(dispatched[0]?.payload.batchId).toBe(batch.id)
  })

  test('every success counts down, and the last one finishes it', async () => {
    const driver = new SyncQueue('sync', (queued) => runnerFor(driver).run(queued))

    const batch = await new PendingBatch(
      {
        batches: () => batches,
        jobs: { has: () => true, register: () => undefined },
        dispatch: async (job: AnyJob, options: { batchId?: string }) => {
          const payload = payloadFor(job.constructor.name, { ...(job.data as object) })
          payload.batchId = options.batchId
          await driver.push(payload)

          return payload.uuid
        }
      } as never,
      [new Counted({ label: 'a' }), new Counted({ label: 'b' })]
    ).dispatch()

    const finished = await batch.fresh()

    expect(Counted.ran.sort()).toEqual(['a', 'b'])
    expect(finished?.pendingJobs).toBe(0)
    expect(finished?.progress).toBe(100)
    expect(finished?.finished).toBe(true)
  })

  test('the then callback is dispatched when the batch completes', async () => {
    const queue: JobPayload[] = []
    const driver = new SyncQueue('sync', async (queued) => {
      queue.push(queued.payload)
      await runnerFor(driver).run(queued)
    })

    await new PendingBatch(
      {
        batches: () => batches,
        jobs: { has: () => true, register: () => undefined },
        dispatch: async (job: AnyJob, options: { batchId?: string }) => {
          const payload = payloadFor(job.constructor.name, { ...(job.data as object) })
          payload.batchId = options.batchId
          await driver.push(payload)

          return payload.uuid
        }
      } as never,
      [new Counted({ label: 'a' })]
    )
      .onSuccess(Afterwards as never)
      .dispatch()

    expect(Afterwards.seen).toHaveLength(1)
  })

  test('a chain inside a batch counts as all of its links', async () => {
    const batch = await new PendingBatch(chainingDispatcher() as never, [
      new Counted({ label: 'alone' }),
      [new Counted({ label: 'first' }), new Counted({ label: 'second' })]
    ]).dispatch()

    // Two entries, three jobs: counting the chain as one would finish the batch
    // while two of its jobs were still queued.
    expect<number>(batch.totalJobs).toBe(3)
    expect<number>(dispatched.length).toBe(2)

    const chained = dispatched[1]?.payload

    // Only the head is queued; the rest travel in its payload.
    expect<number>(chained?.chain?.length ?? 0).toBe(1)
    // And every link belongs to the batch, or the count never reaches zero.
    expect<string | undefined>(chained?.chain?.[0]?.batchId).toBe(batch.id)
  })

  test('the batch finishes only after every link has run', async () => {
    const queued: JobPayload[] = []
    const driver = new SyncQueue('sync', async (job) => {
      queued.push(job.payload)
      await runnerFor(driver).run(job)
    })

    const batch = await new PendingBatch(chainingDispatcher(driver) as never, [
      [
        new Counted({ label: 'one' }),
        new Counted({ label: 'two' }),
        new Counted({ label: 'three' })
      ]
    ])
      .onSuccess(Afterwards as never)
      .dispatch()

    const finished = await batch.fresh()

    // In order, which is what a chain is for.
    expect<string[]>(Counted.ran).toEqual(['one', 'two', 'three'])
    expect<number | undefined>(finished?.pendingJobs).toBe(0)
    expect<boolean | undefined>(finished?.finished).toBe(true)
    // Once, at the end — not after the first link.
    expect<number>(Afterwards.seen.length).toBe(1)
  })

  test('a cancelled batch skips the jobs it cannot delete', async () => {
    const batch = await batches.store({
      id: 'batch-1',
      name: 'import',
      totalJobs: 2,
      pendingJobs: 2,
      failedJobs: 0,
      failedJobIds: [],
      options: {},
      createdAt: Math.floor(Date.now() / 1000)
    })

    await batch.cancel()

    const payload = payloadFor('Counted', { label: 'a' })
    payload.batchId = 'batch-1'

    const driver = new SyncQueue('sync', (queued) => runnerFor(driver).run(queued))
    await driver.push(payload)

    // A driver has no random access, so cancelling cannot remove what is already
    // queued: it is dropped when reserved instead.
    expect(Counted.ran).toEqual([])
  })

  test('progress is a percentage, and an empty batch is complete', async () => {
    const batch = await batches.store({
      id: 'empty',
      name: '',
      totalJobs: 0,
      pendingJobs: 0,
      failedJobs: 0,
      failedJobIds: [],
      options: {},
      createdAt: 0
    })

    expect(batch.progress).toBe(100)
  })

  test('recording a failure cancels the batch unless failures are allowed', async () => {
    await batches.store({
      id: 'strict',
      name: '',
      totalJobs: 2,
      pendingJobs: 2,
      failedJobs: 0,
      failedJobIds: [],
      options: {},
      createdAt: 0
    })

    const payload = payloadFor('Breaks', { label: 'a' })
    payload.batchId = 'strict'

    const driver = new SyncQueue('sync', () => Promise.resolve())
    const runner = runnerFor(driver)

    await runner.recordBatchFailure({ payload } as never)

    expect((await batches.find('strict'))?.cancelled).toBe(true)
    expect((await batches.find('strict'))?.failedJobs).toBe(1)
  })

  test('allowFailures keeps the rest of the batch running', async () => {
    await batches.store({
      id: 'lenient',
      name: '',
      totalJobs: 2,
      pendingJobs: 2,
      failedJobs: 0,
      failedJobIds: [],
      options: { allowFailures: true },
      createdAt: 0
    })

    const payload = payloadFor('Breaks', { label: 'a' })
    payload.batchId = 'lenient'

    const driver = new SyncQueue('sync', () => Promise.resolve())
    await runnerFor(driver).recordBatchFailure({ payload } as never)

    expect((await batches.find('lenient'))?.cancelled).toBe(false)
  })

  test('the catch callback fires once, on the first failure', async () => {
    const queued: JobPayload[] = []
    const driver = new SyncQueue('sync', (job) => {
      queued.push(job.payload)

      return Promise.resolve()
    })

    await batches.store({
      id: 'caught',
      name: '',
      totalJobs: 3,
      pendingJobs: 3,
      failedJobs: 0,
      failedJobIds: [],
      options: { allowFailures: true, onFailure: ['Rescue'] },
      createdAt: 0
    })

    const runner = runnerFor(driver)

    for (const label of ['a', 'b']) {
      const payload = payloadFor('Breaks', { label })
      payload.batchId = 'caught'
      await runner.recordBatchFailure({ payload } as never)
    }

    // Two failures, one catch: it marks the batch turning bad, not each casualty.
    expect(queued.filter((payload) => payload.job === 'Rescue')).toHaveLength(1)
  })
})

describe('maxExceptions', () => {
  /** The slice of a cache the counter needs, in memory. */
  function counter() {
    const values = new Map<string, number>()

    return {
      values,
      add: async (key: string, value: unknown) => {
        if (values.has(key)) return false

        values.set(key, Number(value))

        return true
      },
      increment: async (key: string, amount = 1) => {
        const next = (values.get(key) ?? 0) + amount
        values.set(key, next)

        return next
      },
      forget: async (key: string) => values.delete(key)
    }
  }

  class Flaky extends Job<Record<string, never>> {
    static override tries = 25
    static override maxExceptions = 2

    async handle(): Promise<void> {
      throw new Error('still broken')
    }
  }

  test('a job gives up after too many throws, even with attempts left', async () => {
    const cache = counter()
    const registry = new JobRegistry().register(Flaky)
    const runner = new JobRunner(registry, new ModelRegistry(), {})

    const worker = new Worker(
      {
        pop: async () => null,
        push: async () => '',
        later: async () => '',
        size: async () => 0,
        clear: async () => 0,
        defaultQueue: 'default'
      } as never,
      runner,
      new ArrayFailedJobStore(),
      undefined,
      cache
    )

    const payload = payloadFor('Flaky', {})
    payload.maxTries = 25
    payload.maxExceptions = 2

    let failed = false
    let attempts = 0

    const reserved = {
      payload,
      queue: 'default',
      connectionName: 'sync',
      attempts: () => attempts,
      isDeleted: () => false,
      isReleased: () => false,
      hasFailed: () => failed,
      delete: async () => undefined,
      release: async () => undefined,
      fail: async () => {
        failed = true
      }
    } as never

    // Two throws with `tries = 25`: the attempt limit is nowhere near, and the job
    // stops anyway. That distinction is the whole point of maxExceptions — a job
    // released often on purpose should still give up when it is actually broken.
    attempts = 1
    await worker.process(reserved, {})
    expect(failed).toBe(false)

    attempts = 2
    await worker.process(reserved, {})
    expect(failed).toBe(true)

    // The counter is dropped when it fires, so a retry starts clean.
    expect(cache.values.has(`job-exceptions:${payload.uuid}`)).toBe(false)
  })

  test('without maxExceptions the attempt limit is the only limit', async () => {
    const cache = counter()
    const registry = new JobRegistry().register(Failing)
    const runner = new JobRunner(registry, new ModelRegistry(), {})

    const worker = new Worker(
      {
        pop: async () => null,
        push: async () => '',
        later: async () => '',
        size: async () => 0,
        clear: async () => 0,
        defaultQueue: 'default'
      } as never,
      runner,
      new ArrayFailedJobStore(),
      undefined,
      cache
    )

    const payload = payloadFor('Failing', {})
    payload.maxTries = 5

    let failed = false

    await worker.process(
      {
        payload,
        queue: 'default',
        connectionName: 'sync',
        attempts: () => 1,
        isDeleted: () => false,
        isReleased: () => false,
        hasFailed: () => failed,
        delete: async () => undefined,
        release: async () => undefined,
        fail: async () => {
          failed = true
        }
      } as never,
      {}
    )

    expect(failed).toBe(false)
    expect(cache.values.size).toBe(0)
  })
})

describe('restarting workers on signal', () => {
  class Slow extends Job<{ label: string }> {
    static ran: string[] = []

    async handle(): Promise<void> {
      Slow.ran.push(this.data.label)
    }
  }

  /** A queue in a list — enough to drive a worker, with nothing to set up. */
  function memoryQueue() {
    const waiting: JobPayload[] = []

    const driver: QueueDriver = {
      connectionName: 'memory',
      defaultQueue: 'default',
      push: async (payload) => {
        waiting.push(payload)

        return payload.uuid
      },
      later: async (_delay, payload) => {
        waiting.push(payload)

        return payload.uuid
      },
      pop: async () => {
        const payload = waiting.shift()

        if (!payload) return null

        return {
          payload,
          queue: 'default',
          connectionName: 'memory',
          attempts: () => 1,
          delete: async () => undefined,
          release: async () => undefined,
          fail: async () => undefined,
          isDeleted: () => true,
          isReleased: () => false,
          hasFailed: () => false
        }
      },
      size: async () => waiting.length,
      clear: async () => {
        const count = waiting.length
        waiting.length = 0

        return count
      }
    }

    return driver
  }

  const runner = () => new JobRunner(new JobRegistry().register(Slow), new ModelRegistry(), {})

  test('a worker stops after the job in hand when the signal changes', async () => {
    Slow.ran = []

    const driver = memoryQueue()
    for (const label of ['a', 'b', 'c']) await driver.push(payloadFor('Slow', { label }))

    let signal = 1

    const result = await new Worker(driver, runner()).work(undefined, {
      // Changes after the first read, as `queue:restart` would mid-run.
      restartSignal: async () => {
        const current = signal
        signal = 2

        return current
      }
    })

    // The job in hand finishes; the rest are left for the worker that replaces
    // this one. Killing mid-job would leave it reserved until it expired.
    expect<string>(result.reason).toBe('restart')
    expect<number>(Slow.ran.length).toBe(1)
    expect<number>(await driver.size()).toBe(2)
  })

  test('an unchanged signal is not a restart', async () => {
    Slow.ran = []

    const driver = memoryQueue()
    await driver.push(payloadFor('Slow', { label: 'a' }))

    const result = await new Worker(driver, runner()).work(undefined, {
      stopWhenEmpty: true,
      restartSignal: async () => 7
    })

    // A worker started *after* a signal must not quit at once, which is why the
    // comparison is against the value read at start-up.
    expect<string>(result.reason).toBe('empty')
    expect<number>(Slow.ran.length).toBe(1)
  })
})

describe('encrypting some fields of a payload', () => {
  const encrypter = {
    encrypt: (value: unknown, context = '') => `enc(${context}):${JSON.stringify(value)}`,
    decrypt: <T,>(payload: string, context = ''): T => {
      const prefix = `enc(${context}):`

      if (!payload.startsWith(prefix)) throw new Error('wrong context')

      return JSON.parse(payload.slice(prefix.length)) as T
    },
    encryptString: (value: string) => value,
    decryptString: (value: string) => value
  }

  class PartlySecret extends Job<{ customer: string; card: string }> {
    static override encrypted = ['card']
    static seen: Array<{ customer: string; card: string }> = []

    async handle(): Promise<void> {
      PartlySecret.seen.push({ ...this.data })
    }
  }

  test('the named field is hidden and the rest stays readable', async () => {
    const app = new Application(process.cwd())
    app.config.set('queue.default', 'sync')
    app.config.set('queue.connections', { sync: { driver: 'sync' } })
    app.instance('encrypter' as never, encrypter as never)

    const manager = new QueueManager(app)
    const payload = await manager.payloadFor(new PartlySecret({ customer: 'Ada', card: '4111' }), {})

    // The whole-payload form hides the fields you search a failed-jobs table by;
    // this keeps them.
    expect<unknown>(payload.data.customer).toBe('Ada')
    expect<boolean>(String(payload.data.card).startsWith('enc(')).toBe(true)
    expect<unknown>(payload.data.__encryptedFields).toEqual(['card'])
  })

  test('the worker gets it back, bound to its own field', async () => {
    PartlySecret.seen = []

    const runner = new JobRunner(new JobRegistry().register(PartlySecret), new ModelRegistry(), {
      encrypter: encrypter as never
    })

    const payload = payloadFor('PartlySecret', {
      customer: 'Ada',
      card: encrypter.encrypt('4111', 'job:PartlySecret:card'),
      __encryptedFields: ['card']
    })

    await runner.run({
      payload,
      queue: 'default',
      connectionName: 'sync',
      attempts: () => 1,
      delete: async () => undefined,
      release: async () => undefined,
      fail: async () => undefined,
      isDeleted: () => true,
      isReleased: () => false,
      hasFailed: () => false
    } as never)

    expect<unknown>(PartlySecret.seen[0]).toEqual({ customer: 'Ada', card: '4111' })
  })

  test('a ciphertext moved to another field does not decrypt', async () => {
    const runner = new JobRunner(new JobRegistry().register(PartlySecret), new ModelRegistry(), {
      encrypter: encrypter as never
    })

    // Each field is bound to its own context, so lifting a value from one to
    // another fails rather than quietly succeeding.
    const payload = payloadFor('PartlySecret', {
      customer: 'Ada',
      card: encrypter.encrypt('4111', 'job:PartlySecret:customer'),
      __encryptedFields: ['card']
    })

    await expect(
      runner.run({
        payload,
        queue: 'default',
        connectionName: 'sync',
        attempts: () => 1,
        delete: async () => undefined,
        release: async () => undefined,
        fail: async () => undefined,
        isDeleted: () => true,
        isReleased: () => false,
        hasFailed: () => false
      } as never)
    ).rejects.toThrow('wrong context')
  })
})
