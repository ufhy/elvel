import type { ApplicationContract } from '@elysian/contracts'
import { ArrayBatchRepository, type BatchRepository, DatabaseBatchRepository } from './batch.ts'
import { type BatchEntry, PendingBatch } from './bus.ts'
import type { FailedJobStore, JobPayload, QueueDriver } from './contracts.ts'
import { DatabaseQueue } from './drivers/database.ts'
import { RedisQueue } from './drivers/redis.ts'
import { SqsQueue } from './drivers/sqs.ts'
import { SyncQueue } from './drivers/sync.ts'
import { ArrayFailedJobStore, DatabaseFailedJobStore } from './failed.ts'
import { FakeQueue, QueueFake } from './fake.ts'
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
  /**
   * Hold the push until the enclosing transaction commits — `Job.afterCommit`
   * for one dispatch. `false` overrides a job that asked for it.
   */
  afterCommit?: boolean
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
  private faked?: FakeQueue

  constructor(private readonly app: ApplicationContract) {}

  /**
   * Start a batch — `Bus::batch([...])`.
   *
   * ```ts
   * await queue().batch([new ImportRow(1), new ImportRow(2)]).onSuccess(Notify).dispatch()
   * ```
   *
   * An array inside the list is a **chain**: those jobs run in order, while the
   * entries beside them run alongside. That is the shape of most bulk work — ten
   * imports that each need three steps in sequence — and neither a plain batch
   * nor a plain chain says it.
   *
   * ```ts
   * await queue().batch([
   *   [new Fetch(1), new Transform(1), new Load(1)],
   *   [new Fetch(2), new Transform(2), new Load(2)]
   * ]).dispatch()
   * ```
   */
  batch(jobs: BatchEntry[]): PendingBatch {
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

  /**
   * Record every push instead of queueing it — `Queue::fake()`.
   *
   * `sync` is not a substitute: running the job inline proves the job works,
   * which is a different question from "did this controller dispatch it", and a
   * job that sends mail or charges a card runs for real. Faked, every connection
   * resolves to the same recorder, so a job dispatched onto `redis` is caught by
   * a test that never had Redis.
   *
   * ```ts
   * const fake = queue().fake()
   * await test(app).postJson('/articles/1/publish', {})
   * fake.assertPushed('SendArticleDigest')
   * ```
   */
  fake(): QueueFake {
    const driver = new FakeQueue(
      this.defaultConnection(),
      this.app.config.get<string>(`queue.connections.${this.defaultConnection()}.queue`, 'default')
    )

    this.faked = driver
    // Anything already resolved would still be the real driver.
    this.connections.clear()

    return new QueueFake(driver)
  }

  /** Stop faking and queue for real again. */
  restore(): void {
    this.faked = undefined
    this.connections.clear()
  }

  get isFaking(): boolean {
    return this.faked !== undefined
  }

  connection(name?: string): QueueDriver {
    // Every connection while faking, so a job pinned to another one is still seen.
    if (this.faked) return this.faked

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
    const push = () => (delay > 0 ? driver.later(delay, payload, queue) : driver.push(payload, queue))

    if (!(options.afterCommit ?? jobClass.afterCommit ?? false)) return push()

    return this.pushAfterCommit(payload, push)
  }

  /**
   * Hold a push until the outermost transaction commits.
   *
   * What the caller gets back is the payload's uuid rather than the driver's
   * identifier, because at this point there is no row and no Redis entry to have
   * an identifier — and waiting for one would mean waiting for the commit, which
   * is the thing the caller asked not to do. The uuid identifies the job in the
   * failed table, in the logs and to a batch, so it is the more useful of the two
   * anyway.
   *
   * With no database bound there is no transaction to wait for, and the job goes
   * now: a queue is allowed to exist without one.
   */
  private async pushAfterCommit(payload: JobPayload, push: () => Promise<string>): Promise<string> {
    if (!this.app.bound('db')) {
      await push()

      return payload.uuid
    }

    const connection = await this.app.make('db').connection()

    // Dropped entirely on a rollback, by the connection: a job about rows that
    // never existed must not run.
    await connection.afterCommit(push)

    return payload.uuid
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

    /**
     * Every link inherits the batch id — Laravel's `prepareBatchedChain`.
     *
     * Without it only the first link would count against the batch, so a batch
     * containing a three-job chain would report itself finished after the first
     * one succeeded and fire `onSuccess` while two jobs were still to run.
     */
    const chain: JobPayload[] = []
    for (const link of options.chain ?? []) {
      chain.push(
        await this.payloadFor(
          link,
          options.batchId === undefined ? {} : { batchId: options.batchId }
        )
      )
    }

    let data = serializeData(job.data) as Record<string, unknown>
    let encrypted = false

    /**
     * `static encrypted = ['card']` — encrypt some fields, leave the rest.
     *
     * The whole-payload form hides everything, which also hides the fields you
     * search a failed-jobs table by: "which customer was this for" becomes
     * unanswerable without a key. Naming the sensitive fields keeps the rest
     * readable, and each is bound to its own context so a ciphertext cannot be
     * moved between fields any more than between jobs.
     */
    if (Array.isArray(jobClass.encrypted)) {
      if (!this.app.bound('encrypter')) {
        throw new Error(
          `Job [${jobClass.name}] asks for encrypted fields. Register EncryptionServiceProvider, or they would be stored in the clear.`
        )
      }

      const encrypter = this.app.make('encrypter')
      const fields: string[] = []

      for (const field of jobClass.encrypted) {
        if (data[field] === undefined) continue

        data[field] = encrypter.encrypt(data[field], `job:${jobClass.name}:${field}`)
        fields.push(field)
      }

      if (fields.length > 0) data.__encryptedFields = fields
    }

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
      failOnTimeout: jobClass.failOnTimeout === true ? true : undefined,
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

      case 'sqs':
        return new SqsQueue(name, {
          region: config.region as string | undefined,
          accessKeyId: String(config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? ''),
          secretAccessKey: String(
            config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? ''
          ),
          sessionToken: (config.sessionToken ?? process.env.AWS_SESSION_TOKEN) as
            | string
            | undefined,
          prefix: config.prefix as string | undefined,
          queue: config.queue as string | undefined,
          endpoint: config.endpoint as string | undefined,
          visibilityTimeout: config.visibilityTimeout as number | undefined
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
