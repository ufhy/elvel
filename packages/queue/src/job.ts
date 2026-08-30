import type { Batch, BatchRepository } from './batch.ts'
import type { JobPayload, QueuedJob } from './contracts.ts'

/** Middleware wrapped around a job's `handle()`. */
export type JobMiddleware = {
  handle(job: AnyJob, next: () => Promise<void>): Promise<void>
}

/**
 * Any job, whatever data it carries.
 *
 * `unknown` rather than the default type argument: `data` is only ever read, so
 * `Job<{ id: string }>` is assignable to `Job<unknown>` — which is what lets
 * `dispatch()` take a job of any shape.
 */
export type AnyJob = Job<unknown>

/**
 * A queued job — Laravel's `ShouldQueue` class with its `handle()`.
 *
 * ```ts
 * export class SendWelcomeEmail extends Job<{ userId: string }> {
 *   static override tries = 3
 *   static override backoff = [5, 30, 120]
 *
 *   async handle() {
 *     const user = await User.findOrFail(this.data.userId)
 *   }
 * }
 *
 * await dispatch(new SendWelcomeEmail({ userId: user.id }))
 * ```
 *
 * The class is found by name when a worker picks the payload up, and the data
 * travels in the payload. That is the one real difference from Laravel, where the
 * object itself is serialised: PHP can `serialize($job)`, TypeScript cannot, so
 * the base class owns `data` and it is `data` that is written and read back.
 */
export abstract class Job<TData = Record<string, never>> {
  constructor(readonly data: TData) {}

  /**
   * What `queue:failed` and the logs call this job.
   *
   * Defaults to the class name. A job that wraps something else — a queued
   * listener, a queued mailable — sets it so the entry names what the reader
   * cares about rather than the wrapper.
   */
  static displayName: string | undefined

  /** Queue this job goes on when the dispatch does not say. */
  static queue: string | undefined

  /** Connection this job goes on when the dispatch does not say. */
  static connection: string | undefined

  /** Attempts allowed. `0` means keep retrying until `retryUntil`. */
  static tries: number | undefined

  /** Exceptions allowed before failing, even when attempts remain. */
  static maxExceptions: number | undefined

  /** Seconds before a retry. A list is indexed by attempt number. */
  static backoff: number | number[] | undefined

  /**
   * Hold the push until the enclosing database transaction commits.
   *
   * The bug this exists for is the most common one in a queue: a controller
   * opens a transaction, writes a row, dispatches a job about it and commits. A
   * worker is faster than the commit, reserves the job, looks for the row and
   * does not find it — reliably on a busy queue, never on a developer's laptop.
   *
   * Outside a transaction there is nothing to wait for and the job is pushed at
   * once. A rollback drops it entirely: the rows it was about never existed.
   */
  static afterCommit = false

  /** Seconds one attempt may run. */
  static timeout: number | undefined

  /**
   * Fail a timed-out attempt instead of retrying it.
   *
   * The default is to retry, because a timeout is often the network having a bad
   * minute. Set this when it is not: a job whose work simply takes longer than
   * the timeout allows will take just as long on every remaining attempt, and
   * retrying it spends `tries` timeouts to reach the same failure — with the
   * work half-done each time.
   */
  static failOnTimeout = false

  /**
   * Stop retrying after this many seconds from the first dispatch.
   *
   * Checked ahead of `tries`, exactly as the worker does: a job with a deadline
   * keeps its deadline even if attempts remain.
   */
  static retryFor: number | undefined

  /**
   * Only one instance of this job, keyed by `uniqueId()`, may be queued at once.
   * Needs a cache store with locks.
   */
  static unique = false

  /** Seconds the uniqueness lock is held. Defaults to an hour. */
  static uniqueFor: number | undefined

  /**
   * Encrypt this job's data where the queue stores it.
   *
   * Worth it when the payload carries something the queue itself should not hold
   * in the clear — a token, an address, a document. Needs the encryption package;
   * the queue says so rather than storing the data unencrypted anyway.
   */
  static encrypted: boolean | string[] = false

  /** The reserved job, set by the worker before `handle()` runs. */
  protected queuedJob?: QueuedJob

  /** Where batches are counted, when this job belongs to one. */
  protected batches?: BatchRepository

  abstract handle(): Promise<void> | void

  /** Middleware to wrap `handle()` with. */
  middleware(): JobMiddleware[] {
    return []
  }

  /** What makes this instance unique, when `unique` is on. */
  uniqueId(): string {
    return ''
  }

  /** Called once the job has failed for the last time. */
  failed(_error: unknown): Promise<void> | void {}

  /** Give the running job access to the batch bookkeeping. */
  setBatchRepository(repository: BatchRepository | undefined): this {
    this.batches = repository

    return this
  }

  /** Is this job part of a batch at all? */
  batching(): boolean {
    return this.queuedJob?.payload.batchId !== undefined
  }

  /**
   * The batch this job belongs to, read fresh.
   *
   * Read fresh because the useful things to do with it are about *now*: how far
   * the batch has got, and whether it is still worth continuing. The commonest
   * use is the reverse direction — `await (await this.batch())?.cancel()` when a
   * job discovers the whole run is pointless, which stops the remaining jobs
   * without touching the queue itself.
   *
   * Jobs of a batch that was already cancelled never reach `handle()`: the
   * runner drops them at reservation, so this never has to be asked defensively
   * at the top of a job.
   */
  async batch(): Promise<Batch | undefined> {
    const id = this.queuedJob?.payload.batchId

    if (!id || !this.batches) return undefined

    return this.batches.find(id)
  }

  /** Give the running job access to its own reservation. */
  setQueuedJob(job: QueuedJob): this {
    this.queuedJob = job

    return this
  }

  /** Attempts including this one, or 0 when running synchronously. */
  attempts(): number {
    return this.queuedJob?.attempts() ?? 0
  }

  get job(): QueuedJob | undefined {
    return this.queuedJob
  }

  /** Do not retry: finish this attempt and remove the job. */
  async deleteJob(): Promise<void> {
    await this.queuedJob?.delete()
  }

  /** Put the job back on the queue, optionally after a delay. */
  async releaseJob(delay = 0): Promise<void> {
    await this.queuedJob?.release(delay)
  }

  /** Fail now, without using up the remaining attempts. */
  async failJob(error: unknown): Promise<void> {
    await this.queuedJob?.fail(error)
  }

  /** The payload this job is running from, when queued. */
  get payload(): JobPayload | undefined {
    return this.queuedJob?.payload
  }
}

/** A job class, as the registry holds it. */
export type JobClass = (new (
  data: never
) => AnyJob) & {
  displayName?: string | undefined
  queue?: string | undefined
  connection?: string | undefined
  tries?: number | undefined
  maxExceptions?: number | undefined
  backoff?: number | number[] | undefined
  timeout?: number | undefined
  failOnTimeout?: boolean
  afterCommit?: boolean
  retryFor?: number | undefined
  unique?: boolean
  uniqueFor?: number | undefined
  encrypted?: boolean | string[]
}

/**
 * Jobs the worker can resolve, keyed by name.
 *
 * The worker is a separate process from the dispatcher, so a payload can only
 * carry a name. Discovery fills this from `app/Jobs`, and `register()` adds
 * anything that lives elsewhere.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobClass>()

  /** How to find the jobs nobody registered by hand, and whether it has run. */
  private discovery: (() => Promise<JobClass[]>) | undefined
  private discovered: Promise<void> | undefined

  register(...jobs: JobClass[]): this {
    for (const job of jobs) this.jobs.set(job.name, job)

    return this
  }

  /**
   * Where to look for jobs nobody named, when somebody asks for one that is missing.
   *
   * `app/Jobs` used to be read and imported during `boot()`, on every process:
   * seven job files cost **118ms** on the playground, paid by `elvel key:generate`
   * as much as by a worker, because a job file pulls in the models and mailers it
   * uses. Almost nothing needs it — dispatching a job registers its own class on
   * the way past, so the only caller that resolves a name it has never seen is a
   * worker rebuilding a job from a payload.
   *
   * The cost of waiting is where a broken job file surfaces: at the first lookup
   * that misses rather than at boot. A worker still finds it on its first job, and
   * `queue:work` on an empty queue was never going to run the file anyway.
   */
  discoverWith(discovery: () => Promise<JobClass[]>): this {
    this.discovery = discovery

    return this
  }

  get(name: string): JobClass | undefined {
    return this.jobs.get(name)
  }

  /**
   * The job a name refers to, discovering `app/Jobs` if it has not been read yet.
   *
   * Discovery runs at most once, whether it found the name or not: a second miss
   * is a job that does not exist, and re-reading the directory to be told so again
   * would turn a typo in a payload into a directory scan per failed job.
   */
  async find(name: string): Promise<JobClass | undefined> {
    const known = this.jobs.get(name)

    if (known !== undefined) return known

    await this.discover()

    return this.jobs.get(name)
  }

  has(name: string): boolean {
    return this.jobs.has(name)
  }

  /** Every job this application has, which means reading `app/Jobs` first. */
  async all(): Promise<string[]> {
    await this.discover()

    return this.names()
  }

  /** Only what is registered — `all()` is the one that goes looking. */
  names(): string[] {
    return [...this.jobs.keys()].sort()
  }

  private async discover(): Promise<void> {
    if (this.discovery === undefined) return

    this.discovered ??= this.discovery().then((jobs) => {
      this.register(...jobs)
    })

    await this.discovered
  }
}
