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

  /** Seconds one attempt may run. */
  static timeout: number | undefined

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

  register(...jobs: JobClass[]): this {
    for (const job of jobs) this.jobs.set(job.name, job)

    return this
  }

  get(name: string): JobClass | undefined {
    return this.jobs.get(name)
  }

  has(name: string): boolean {
    return this.jobs.has(name)
  }

  names(): string[] {
    return [...this.jobs.keys()].sort()
  }
}
