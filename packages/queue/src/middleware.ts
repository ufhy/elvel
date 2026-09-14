import type { Lock, RateLimiter, Repository } from '@elvel/cache'
import type { AnyJob, JobMiddleware } from './job.ts'

/**
 * Let only one instance of a job run at a time.
 *
 * The difference from a unique job is *when* the guard applies: unique stops a
 * duplicate being **queued**, this stops two that are already queued from
 * **running** together. Without a callback to release the job, the second one
 * would spin; the default is to put it back with a delay so the first can finish.
 */
export class WithoutOverlapping implements JobMiddleware {
  private readonly lock: Lock

  constructor(
    cache: Repository,
    key: string,
    private readonly options: {
      /** Seconds the lock is held, in case the holder dies. */
      expiresAfter?: number
      /** Seconds to wait before retrying a job that could not get in. */
      releaseAfter?: number | false
    } = {}
  ) {
    this.lock = cache.lock(`elvel:queue:overlap:${key}`, options.expiresAfter ?? 0)
  }

  async handle(job: AnyJob, next: () => Promise<void>): Promise<void> {
    if (!(await this.lock.acquire())) {
      const releaseAfter = this.options.releaseAfter ?? 0

      // `false` means drop it: the work is already being done by the holder, so a
      // retry would only repeat it.
      if (releaseAfter === false) await job.deleteJob()
      else await job.releaseJob(releaseAfter)

      return
    }

    try {
      await next()
    } finally {
      await this.lock.release()
    }
  }
}

/**
 * Hold a job back when a limit has been reached.
 *
 * The job is released rather than dropped, so the work still happens; it happens
 * later. The delay comes from the limiter itself, which knows when the window
 * closes, instead of a guess.
 */
export class RateLimited implements JobMiddleware {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly key: string,
    private readonly maxAttempts: number,
    private readonly decaySeconds = 60
  ) {}

  async handle(job: AnyJob, next: () => Promise<void>): Promise<void> {
    if (await this.limiter.tooManyAttempts(this.key, this.maxAttempts)) {
      await job.releaseJob(await this.limiter.availableIn(this.key))

      return
    }

    await this.limiter.hit(this.key, this.decaySeconds)

    await next()
  }
}

/**
 * Delete the job instead of running it when a condition holds.
 *
 * Useful for one case: a job whose reason to
 * exist disappeared while it sat in the queue.
 */
export class Skip implements JobMiddleware {
  constructor(private readonly when: (job: AnyJob) => boolean | Promise<boolean>) {}

  async handle(job: AnyJob, next: () => Promise<void>): Promise<void> {
    if (await this.when(job)) {
      await job.deleteJob()

      return
    }

    await next()
  }
}

/**
 * Stop hammering a service that is already down.
 *
 * The first thing anybody adds after their first outage, and there was nothing
 * to add. A job calling a third-party API that has gone down fails, retries,
 * fails, retries — for every job in the backlog, against a service that is
 * struggling — until the attempts run out and the whole queue is in
 * `failed_jobs`.
 *
 * After `maxAttempts` failures the circuit opens: every further job is
 * **released** rather than attempted, so nothing is lost and nothing is sent.
 * The circuit lives in the cache, so it is shared across every worker — a
 * per-process breaker would open N times and let N jobs through per failure.
 */
export class ThrottlesExceptions implements JobMiddleware {
  constructor(
    private readonly cache: Repository,
    private readonly key: string,
    private readonly maxAttempts = 10,
    private readonly options: {
      /** Seconds the circuit stays open once it trips. */
      decaySeconds?: number
      /** Seconds a held-back job waits before trying again. */
      retryAfterSeconds?: number
      /** Which failures count. Default: all of them. */
      when?: (error: unknown) => boolean | Promise<boolean>
      /** Report a failure without letting it count — for an expected 404. */
      report?: (error: unknown) => void
    } = {}
  ) {}

  async handle(job: AnyJob, next: () => Promise<void>): Promise<void> {
    const decay = this.options.decaySeconds ?? 600
    const retryAfter = this.options.retryAfterSeconds ?? decay

    if (await this.cache.has(this.openKey())) {
      // Released, not failed: the service being down is not this job's fault,
      // and the backlog is the thing worth preserving.
      await job.releaseJob(retryAfter)

      return
    }

    try {
      await next()
    } catch (error) {
      this.options.report?.(error)

      if (this.options.when !== undefined && !(await this.options.when(error))) throw error

      const failures = (await this.cache.get<number>(this.countKey())) ?? 0
      const total = failures + 1

      /**
       * The count carries the decay too.
       *
       * Ten failures spread over a week is a flaky call, not an outage. Without
       * a window the counter only ever climbs and the circuit opens eventually
       * whatever the service is doing.
       */
      await this.cache.put(this.countKey(), total, decay)

      if (total >= this.maxAttempts) {
        await this.cache.put(this.openKey(), true, decay)
        await this.cache.forget(this.countKey())
      }

      throw error
    }
  }

  /** Close it by hand — for a deploy that fixed the thing that was failing. */
  async reset(): Promise<void> {
    await this.cache.forget(this.openKey())
    await this.cache.forget(this.countKey())
  }

  /** Whether the circuit is open right now. For a health endpoint. */
  isOpen(): Promise<boolean> {
    return this.cache.has(this.openKey())
  }

  private openKey(): string {
    return `elvel:queue:circuit:${this.key}:open`
  }

  private countKey(): string {
    return `elvel:queue:circuit:${this.key}:failures`
  }
}

/**
 * Fail the job outright instead of retrying, for the errors a retry cannot fix.
 *
 * A malformed payload, a row that was deleted, a 422 from an API: the second
 * attempt fails the same way as the first, and the third fills the log.
 */
export class FailOnException implements JobMiddleware {
  constructor(private readonly types: Array<new (...args: any[]) => Error>) {}

  async handle(job: AnyJob, next: () => Promise<void>): Promise<void> {
    try {
      await next()
    } catch (error) {
      if (this.types.some((type) => error instanceof type)) {
        await job.failJob(error)

        return
      }

      throw error
    }
  }
}

/**
 * Put the job back when a condition holds, instead of running it.
 *
 * `Skip` deletes and this releases, and the difference is whether the work still
 * needs doing: a job whose reason to exist is gone should be dropped, and a job
 * whose moment has not come should wait.
 */
export class Release implements JobMiddleware {
  constructor(
    private readonly when: (job: AnyJob) => boolean | Promise<boolean>,
    private readonly delaySeconds = 60
  ) {}

  async handle(job: AnyJob, next: () => Promise<void>): Promise<void> {
    if (await this.when(job)) {
      await job.releaseJob(this.delaySeconds)

      return
    }

    await next()
  }
}

/**
 * Drop a job whose batch was cancelled.
 *
 * A cancelled batch of ten thousand jobs still has ten thousand jobs in the
 * queue, and without this every one of them runs.
 */
export class SkipIfBatchCancelled implements JobMiddleware {
  constructor(
    private readonly batches: { find(id: string): Promise<{ cancelled: boolean } | null> }
  ) {}

  async handle(job: AnyJob, next: () => Promise<void>): Promise<void> {
    const batchId = job.payload?.batchId

    if (batchId !== undefined) {
      const batch = await this.batches.find(batchId)

      if (batch?.cancelled === true) {
        await job.deleteJob()

        return
      }
    }

    await next()
  }
}
