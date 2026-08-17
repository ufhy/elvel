import type { Lock, RateLimiter, Repository } from '@elyvel/cache'
import type { AnyJob, JobMiddleware } from './job.ts'

/**
 * Let only one instance of a job run at a time — Laravel's
 * `WithoutOverlapping`.
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
    this.lock = cache.lock(`elyvel:queue:overlap:${key}`, options.expiresAfter ?? 0)
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
 * Hold a job back when a limit has been reached — Laravel's `RateLimited`.
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
 * Useful for the case Laravel's `Skip` middleware covers: a job whose reason to
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
