import type { ApplicationContract } from '@elysian/contracts'
import { ArrayBatchRepository, type BatchRepository, DatabaseBatchRepository } from './batch.ts'
import { PendingBatch } from './bus.ts'
import type { FailedJobStore, JobPayload, QueueDriver } from './contracts.ts'
import { DatabaseQueue } from './drivers/database.ts'
import { RedisQueue } from './drivers/redis.ts'
import { SyncQueue } from './drivers/sync.ts'
import { ArrayFailedJobStore, DatabaseFailedJobStore } from './failed.ts'
import { type AnyJob, type JobClass, JobRegistry } from './job.ts'
import { JobRunner } from './runner.ts'
import { ModelRegistry, serializeData } from './serializer.ts'
import { Worker } from './worker.ts'

export type ConnectionConfig = { driver: string } & Record<string, unknown>

/** Builds a driver from its configuration — how `extend()` adds one. */
export type DriverFactory = (
  name: string,
  config: ConnectionConfig,
  app: ApplicationContract
) => QueueDriver

export type DispatchOptions = {
  queue?: string
  connection?: string
  /** Seconds to wait before the job becomes available. */
  delay?: number
  /** Jobs to run after this one succeeds, in order. */
  chain?: AnyJob[]
  /** Set by a batch; the worker counts the job against it. */
  batchId?: string
}

/**
 * Resolves connections and dispatches jobs — `Illuminate\Queue\QueueManager`
 * with the parts of `Bus\Dispatcher` that matter here.
 */
export class QueueManager {
  /** Jobs a worker can resolve by name. Filled by discovery and `register()`. */
  readonly jobs = new JobRegistry()

  /** Models that may travel through a payload as a reference. */
  readonly models = new ModelRegistry()

  private readonly connections = new Map<string, QueueDriver>()
  private batchRepository?: BatchRepository
  private readonly customDrivers = new Map<string, DriverFactory>()
  private failedStore?: FailedJobStore

  constructor(private readonly app: ApplicationContract) {}

  /**
   * Start a batch — `Bus::batch([...])`.
   *
   * ```ts
   * await queue().batch([new ImportRow(1), new ImportRow(2)]).then(Notify).dispatch()
   * ```
   */
  batch(jobs: AnyJob[]): PendingBatch {
    return new PendingBatch(this as never, jobs)
  }

  /** Where batches are recorded. A table when one is configured, memory otherwise. */
  batches(): BatchRepository {
    if (this.batchRepository) return this.batchRepository

    const driver = this.app.config.get<string>('queue.batching.driver', 'database')

    this.batchRepository =
      driver === 'database' && this.app.bound('db')
        ? new DatabaseBatchRepository(
            this.app,
            this.app.config.get<string>('queue.batching.table', 'job_batches'),
            this.app.config.get<string | undefined>('queue.batching.connection', undefined)
          )
        : new ArrayBatchRepository()

    return this.batchRepository
  }

  /** Replace the batch store, e.g. in a test. */
  setBatchRepository(repository: BatchRepository): this {
    this.batchRepository = repository

    return this
  }

  connection(name?: string): QueueDriver {
    const resolved = name ?? this.defaultConnection()
    const cached = this.connections.get(resolved)
    if (cached) return cached

    const driver = this.resolve(resolved)
    this.connections.set(resolved, driver)

    return driver
  }

  defaultConnection(): string {
    return this.app.config.get<string>('queue.default', 'sync')
  }

  extend(driver: string, factory: DriverFactory): this {
    this.customDrivers.set(driver, factory)
    this.connections.clear()

    return this
  }

  /** Where failures are recorded. */
  get failed(): FailedJobStore {
    if (!this.failedStore) {
      const driver = this.app.config.get<string>('queue.failed.driver', 'database')

      this.failedStore =
        driver === 'database' && this.app.bound('db')
          ? new DatabaseFailedJobStore(this.app.make('db'), {
              connection: this.app.config.get<string | undefined>('queue.failed.connection'),
              table: this.app.config.get<string>('queue.failed.table', 'failed_jobs')
            })
          : new ArrayFailedJobStore()
    }

    return this.failedStore
  }

  /** Replace the failed-job store, e.g. in a test. */
  setFailedStore(store: FailedJobStore): this {
    this.failedStore = store

    return this
  }

  /**
   * Put a job on a queue.
   *
   * Returns the driver's identifier for it — a row id, or the payload's uuid on
   * Redis — so a caller can record what it queued.
   */
  async dispatch(job: AnyJob, options: DispatchOptions = {}): Promise<string> {
    const jobClass = job.constructor as JobClass

    // Discovery may not have reached a job that was constructed by hand.
    if (!this.jobs.has(jobClass.name)) this.jobs.register(jobClass)

    const connection = options.connection ?? jobClass.connection ?? this.defaultConnection()
    const driver = this.connection(connection)
    const queue = options.queue ?? jobClass.queue ?? driver.defaultQueue

    const payload = await this.payloadFor(job, options)

    // A unique job that is already queued is dropped rather than duplicated. The
    // lock is released once it has *run*, not when it is reserved.
    if (jobClass.unique === true && !(await this.acquireUniqueLock(payload, jobClass))) {
      return payload.uuid
    }

    const delay = options.delay ?? 0

    return delay > 0 ? driver.later(delay, payload, queue) : driver.push(payload, queue)
  }

  /**
   * Run a job now, in this process, whatever the configured connection is.
   *
   * Not the same as the `sync` driver: this bypasses the queue entirely, which is
   * what a controller wants when it needs the result before responding.
   */
  async dispatchSync(job: AnyJob): Promise<void> {
    const payload = await this.payloadFor(job, {})
    const driver = new SyncQueue('sync', (queued) => this.runner().run(queued))

    await driver.push(payload)
  }

  /**
   * Dispatch the first job with the rest queued behind it.
   *
   * Each link is only queued once its predecessor succeeded, which is the
   * difference from dispatching them all at once.
   */
  async chain(jobs: AnyJob[], options: DispatchOptions = {}): Promise<string | null> {
    const [first, ...rest] = jobs
    if (!first) return null

    return this.dispatch(first, { ...options, chain: rest })
  }

  /** A runner wired to this manager's registries. */
  runner(): JobRunner {
    return new JobRunner(this.jobs, this.models, {
      encrypter: this.app.bound('encrypter') ? this.app.make('encrypter') : undefined,
      chain: async (payload, connection, queue) => {
        await this.connection(connection).push(payload, queue)
      },
      locks: this.app.bound('cache') ? this.app.make('cache').store() : undefined,
      batches: this.batches(),
      /**
       * A batch callback is dispatched like any other job, with the batch id in
       * its payload — so it can look the batch up and report on it, and so it gets
       * the retries and the failure record everything else in a worker gets.
       */
      dispatchCallback: async (job, batchId) => {
        const jobClass = this.jobs.get(job)
        if (!jobClass) return

        const instance = new (jobClass as unknown as new (data: unknown) => AnyJob)({ batchId })

        /**
         * The id travels in the callback's **data**, never as its `batchId`.
         *
         * Dispatching it into the batch it reports on makes the batch count its
         * own callback: pending is already zero, so finishing the callback fires
         * `then` again, which dispatches another callback — an infinite loop that
         * a test found by hanging rather than failing.
         */
        return this.dispatch(instance)
      }
    })
  }

  /** A worker for a connection. */
  worker(connection?: string): Worker {
    return new Worker(
      this.connection(connection),
      this.runner(),
      this.failed,
      this.app.bound('events')
        ? (this.app.make('events' as never) as {
            dispatch(event: string, payload?: unknown): unknown
          })
        : undefined,
      // `maxExceptions` counts in the cache, because the count has to survive a
      // release and a different worker picking the job up.
      this.app.bound('cache') ? this.app.make('cache').store() : undefined
    )
  }

  /** Re-queue a failed job from its recorded payload. */
  async retry(id: string | number): Promise<boolean> {
    const record = await this.failed.find(id)
    if (!record) return false

    // Attempts start again: the operator retrying it has decided the cause is
    // fixed, and keeping the old count would fail it immediately.
    await this.connection(record.connection).push({ ...record.payload, attempts: 0 }, record.queue)

    await this.failed.forget(id)

    return true
  }

  /** The payload a job would be queued with. Public so tests can read it. */
  async payloadFor(job: AnyJob, options: DispatchOptions): Promise<JobPayload> {
    const jobClass = job.constructor as JobClass

    const chain: JobPayload[] = []
    for (const link of options.chain ?? []) chain.push(await this.payloadFor(link, {}))

    let data = serializeData(job.data) as Record<string, unknown>
    let encrypted = false

    if (jobClass.encrypted === true) {
      if (!this.app.bound('encrypter')) {
        throw new Error(
          `Job [${jobClass.name}] asks for an encrypted payload. Register EncryptionServiceProvider, or the data would be stored in the clear.`
        )
      }

      // The job's name is the context, so a ciphertext cannot be moved to a
      // different job — a payload meant for `DeleteAccount` must not run as
      // `SendReport`.
      data = {
        __encrypted: this.app.make('encrypter').encrypt(data, `job:${jobClass.name}`)
      }
      encrypted = true
    }

    if (jobClass.unique === true) {
      // Carried in the payload so the runner can release the right lock without
      // rebuilding the job first.
      data.__unique = this.uniqueKey(jobClass.name, job.uniqueId())
    }

    return {
      uuid: crypto.randomUUID(),
      job: jobClass.name,
      displayName: jobClass.displayName ?? jobClass.name,
      data,
      attempts: 0,
      maxTries: jobClass.tries,
      maxExceptions: jobClass.maxExceptions,
      backoff: jobClass.backoff,
      timeout: jobClass.timeout,
      retryUntil: jobClass.retryFor ? Math.floor(Date.now() / 1000) + jobClass.retryFor : undefined,
      chain: chain.length > 0 ? chain : undefined,
      encrypted: encrypted ? true : undefined,
      batchId: options.batchId,
      createdAt: Math.floor(Date.now() / 1000)
    }
  }

  /** Close anything a driver opened. Called on shutdown. */
  disconnect(): void {
    for (const driver of this.connections.values()) {
      if (driver instanceof RedisQueue) driver.disconnect()
    }

    this.connections.clear()
  }

  private resolve(name: string): QueueDriver {
    const config = this.app.config.get<ConnectionConfig | undefined>(`queue.connections.${name}`)

    if (!config) {
      throw new Error(`Queue connection [${name}] is not configured. Add it to config/queue.ts.`)
    }

    const custom = this.customDrivers.get(config.driver)
    if (custom) return custom(name, config, this.app)

    switch (config.driver) {
      case 'sync':
        return new SyncQueue(name, (queued) => this.runner().run(queued))

      case 'database':
        return new DatabaseQueue(name, this.app.make('db'), {
          connection: config.connection as string | undefined,
          table: config.table as string | undefined,
          queue: config.queue as string | undefined,
          retryAfter: config.retryAfter as number | undefined
        })

      case 'redis':
        return new RedisQueue(name, {
          url: config.url as string | undefined,
          prefix: config.prefix as string | undefined,
          queue: config.queue as string | undefined,
          retryAfter: config.retryAfter as number | undefined
        })

      default:
        throw new Error(
          `Queue driver [${config.driver}] for connection [${name}] is not supported. Register it with queue().extend().`
        )
    }
  }

  /**
   * Take the lock a unique job occupies.
   *
   * Needs a cache store with locks; without one, uniqueness cannot be promised,
   * so it says so rather than pretending the job is unique.
   */
  private async acquireUniqueLock(payload: JobPayload, jobClass: JobClass): Promise<boolean> {
    if (!this.app.bound('cache')) {
      throw new Error(
        `Job [${jobClass.name}] is unique, which needs a cache store. Register CacheServiceProvider.`
      )
    }

    const key = String((payload.data as { __unique?: unknown }).__unique)
    const seconds = jobClass.uniqueFor ?? 3600

    return this.app.make('cache').store().add(key, payload.uuid, seconds)
  }

  private uniqueKey(job: string, id: string): string {
    return `elysian:queue:unique:${job}${id === '' ? '' : `:${id}`}`
  }
}
