import type { FailedJobStore, JobPayload, QueueDriver, QueuedJob } from './contracts.ts'
import type { JobRunner } from './runner.ts'

/** The slice of a cache repository the exception counter needs. */
export type ExceptionCounter = {
  add(key: string, value: unknown, seconds: number): Promise<boolean>
  increment(key: string, amount?: number): Promise<number | false>
  forget(key: string): Promise<boolean>
}

export type WorkerOptions = {
  /** Attempts allowed, unless the job says otherwise. `0` is unlimited. */
  maxTries?: number
  /** Seconds before a retry, unless the job says otherwise. */
  backoff?: number | number[]
  /** Seconds one attempt may run. */
  timeout?: number
  /** Seconds to wait when the queue is empty. */
  sleep?: number
  /** Stop once this many jobs have been processed. */
  maxJobs?: number
  /** Stop after this many seconds. */
  maxTime?: number
  /** Stop as soon as the queue is empty. */
  stopWhenEmpty?: boolean
  /**
   * Reads the restart signal — `queue:restart` writes it.
   *
   * Injected rather than reached for: this file has no cache and should not grow
   * one, and a worker without a cache simply never sees a restart.
   */
  restartSignal?: () => Promise<number | undefined>

  /**
   * Whether the queue is paused — `queue:pause` writes it, `queue:resume` clears it.
   *
   * A paused worker stays alive and reserves nothing. That is the difference
   * from `queue:restart`: a restart is for a deploy, a pause is for the twenty
   * minutes while a downstream service is broken and every job would fail and
   * burn its attempts. Nothing is lost either way — the jobs simply wait.
   */
  pausedSignal?: (queue: string) => Promise<boolean>
}

export type WorkerEvents = { dispatch(event: string, payload?: unknown): unknown }

export type WorkerResult = {
  processed: number
  failed: number
  released: number
  reason: 'empty' | 'max-jobs' | 'max-time' | 'restart' | 'stopped'
}

/** Thrown when an attempt outlives its timeout. */
export class TimeoutExceededError extends Error {
  constructor(job: string, seconds: number) {
    super(`Job [${job}] timed out after ${seconds} seconds.`)
    this.name = 'TimeoutExceededError'
  }
}

/** Thrown when a job has used up its attempts. */
export class MaxAttemptsExceededError extends Error {
  constructor(job: string, attempts: number) {
    super(`Job [${job}] has been attempted too many times (${attempts}).`)
    this.name = 'MaxAttemptsExceededError'
  }
}

/**
 * Pulls jobs off a queue and runs them — `Illuminate\Queue\Worker`.
 *
 * The order of the retry policy is transcribed rather than reinvented, because
 * every step of it exists for a failure that happened to somebody:
 *
 * 1. Before running, fail a job that has *already* exceeded its attempts. A job
 *    that keeps timing out never throws, so this is the only place it can be
 *    caught.
 * 2. Run it.
 * 3. On an exception, fail it now if the *next* attempt would exceed the limit —
 *    releasing it first would mean one more pointless run.
 * 4. Otherwise release it with a backoff, but only if the job did not already
 *    delete, release or fail itself.
 *
 * `retryUntil` outranks `maxTries`: a job given a deadline keeps it even when
 * attempts remain.
 */
export class Worker {
  private stopping = false

  constructor(
    private readonly driver: QueueDriver,
    private readonly runner: JobRunner,
    private readonly failed?: FailedJobStore,
    private readonly events?: WorkerEvents,
    /**
     * Where exception counts are kept for `maxExceptions`.
     *
     * A cache rather than the payload: the count has to survive the job being
     * released and reserved again, possibly by a different worker, and the payload
     * is rewritten on every release.
     */
    private readonly cache?: ExceptionCounter
  ) {}

  /** Ask the loop to finish the job in hand and return. */
  stop(): void {
    this.stopping = true
  }

  /**
   * Work the queue until a stop condition is met.
   *
   * `queue` may name several, comma-separated, in priority order — the first with
   * work wins, which is how a `high,default` split is expressed.
   */
  async work(queue?: string, options: WorkerOptions = {}): Promise<WorkerResult> {
    const queues = (queue ?? this.driver.defaultQueue).split(',').map((name) => name.trim())
    const startedAt = Date.now()
    const sleep = options.sleep ?? 3

    const result: WorkerResult = { processed: 0, failed: 0, released: 0, reason: 'stopped' }

    this.stopping = false

    /**
     * The signal as it stood when this worker started.
     *
     * A worker is a long-lived process holding code a deploy has just replaced;
     * `queue:restart` bumps this timestamp and every worker finishes its current
     * job and exits, for the supervisor to start again. Read against the value
     * from *start-up*, so a worker started after a signal does not quit at once.
     *
     * Read **after** `stopping` is cleared, not before: awaiting first lets a
     * `stop()` arriving in that window be overwritten by the line below, and the
     * worker then ignores it for ever. An existing test caught exactly that.
     */
    // Only awaited when there is a signal to read: `await undefined` still
    // yields, and that microtask was enough to let a `stop()` land before the
    // first job was reserved — the same test caught this a second time.
    const startedWith = options.restartSignal ? await options.restartSignal() : undefined

    this.events?.dispatch('queue.worker.starting', { queues })

    while (!this.stopping) {
      /**
       * Checked before reserving, not after.
       *
       * Reserving first and then noticing the pause would leave a job held by a
       * worker that will not run it, invisible to every other worker until its
       * reservation expires.
       */
      if (await this.isPaused(options, queues)) {
        await Bun.sleep(sleep * 1000)
        continue
      }

      const job = await this.reserve(queues)

      if (!job) {
        if (options.stopWhenEmpty) {
          result.reason = 'empty'
          break
        }

        if (this.exceededTime(startedAt, options)) {
          result.reason = 'max-time'
          break
        }

        // An idle worker checks too, or a restart during a quiet hour would wait
        // for the next job to arrive before taking effect.
        if (await this.shouldRestart(options, startedWith)) {
          result.reason = 'restart'
          break
        }

        await this.idle(queues, sleep)
        continue
      }

      const outcome = await this.process(job, options)

      result.processed += 1
      if (outcome === 'failed') result.failed += 1
      if (outcome === 'released') result.released += 1

      if (await this.shouldRestart(options, startedWith)) {
        result.reason = 'restart'
        break
      }

      if (options.maxJobs && result.processed >= options.maxJobs) {
        result.reason = 'max-jobs'
        break
      }

      if (this.exceededTime(startedAt, options)) {
        result.reason = 'max-time'
        break
      }
    }

    this.events?.dispatch('queue.worker.stopping', { ...result })

    return result
  }

  /** Run exactly one job, if one is waiting. Used by tests and by `--once`. */
  async runNextJob(queue?: string, options: WorkerOptions = {}): Promise<'none' | Outcome> {
    const queues = (queue ?? this.driver.defaultQueue).split(',').map((name) => name.trim())
    const job = await this.reserve(queues)

    if (!job) return 'none'

    return this.process(job, options)
  }

  /**
   * Process one reserved job.
   *
   * Returns what happened rather than throwing: a worker that stopped on the
   * first failing job would be a worse worker.
   */
  async process(job: QueuedJob, options: WorkerOptions = {}): Promise<Outcome> {
    const name = job.payload.displayName

    this.events?.dispatch('queue.job.processing', { job: name, attempts: job.attempts() })

    try {
      // Step 1: a job already past its limit is failed before it runs again.
      await this.failIfAlreadyExceeded(job, options)

      if (job.hasFailed()) return 'failed'

      await this.runWithTimeout(job, options)

      this.events?.dispatch('queue.job.processed', { job: name, attempts: job.attempts() })

      if (job.hasFailed()) return 'failed'
      if (job.isReleased()) return 'released'

      return 'processed'
    } catch (error) {
      return this.handleException(job, options, error)
    }
  }

  /**
   * Run the attempt, giving up on it after its timeout.
   *
   * The attempt is *abandoned*, not killed: without process isolation there is no
   * way to stop an async function that is already running. The worker stops
   * waiting and the job is failed or retried, which is the honest half of what
   * Laravel's `pcntl` alarm does — stated in BEHAVIOURS.md rather than implied
   * here.
   */
  private async runWithTimeout(job: QueuedJob, options: WorkerOptions): Promise<void> {
    const seconds = job.payload.timeout ?? options.timeout ?? 0

    if (seconds <= 0) {
      await this.runner.run(job)
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutExceededError(job.payload.displayName, seconds)),
        seconds * 1000
      )
    })

    try {
      await Promise.race([this.runner.run(job), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async failIfAlreadyExceeded(job: QueuedJob, options: WorkerOptions): Promise<void> {
    const maxTries = job.payload.maxTries ?? options.maxTries ?? 1
    const retryUntil = job.payload.retryUntil

    // A deadline that has not passed keeps the job alive whatever the count.
    if (retryUntil && Math.floor(Date.now() / 1000) <= retryUntil) return

    if (!retryUntil && (maxTries === 0 || job.attempts() <= maxTries)) return

    await this.fail(job, new MaxAttemptsExceededError(job.payload.displayName, job.attempts()))
  }

  private async handleException(
    job: QueuedJob,
    options: WorkerOptions,
    error: unknown
  ): Promise<Outcome> {
    this.events?.dispatch('queue.job.exception', {
      job: job.payload.displayName,
      attempts: job.attempts(),
      error
    })

    /**
     * A job that asked to fail on timeout fails here, whatever it has left.
     *
     * The attempts are not the point: work that does not fit in the timeout
     * will not fit in it on the next attempt either, so retrying spends every
     * remaining try to arrive at the same failure — each one having done some
     * fraction of the work again. Off by default, because a timeout is more
     * often the network having a bad minute than the job being too big.
     */
    if (!job.hasFailed() && job.payload.failOnTimeout && error instanceof TimeoutExceededError) {
      await this.fail(job, error)
    }

    if (!job.hasFailed()) {
      // Step 3: give up early when this job has thrown too often, then fail now
      // when the next attempt could not run anyway.
      await this.failIfWillExceedMaxExceptions(job, error)
    }

    if (!job.hasFailed()) {
      await this.failIfWillExceed(job, options, error)
    }

    // Step 4: release, unless the job already decided its own fate.
    if (!job.isDeleted() && !job.isReleased() && !job.hasFailed()) {
      await job.release(this.backoffFor(job, options))

      this.events?.dispatch('queue.job.released', {
        job: job.payload.displayName,
        attempts: job.attempts()
      })

      return 'released'
    }

    return job.hasFailed() ? 'failed' : 'processed'
  }

  /**
   * `maxExceptions` — give up after this many throws, even with attempts left.
   *
   * The distinction from `tries` is the point: a job with `tries = 25` and
   * `maxExceptions = 3` is one that is *expected* to be released often (a lock it
   * cannot take, a rate limit) but should stop if it is actually broken. Counting
   * releases and counting exceptions are different questions.
   *
   * Keyed by the payload's uuid, which survives a release; the counter is dropped
   * when it fires, so a retried batch starts clean.
   */
  private async failIfWillExceedMaxExceptions(job: QueuedJob, error: unknown): Promise<void> {
    const max = job.payload.maxExceptions
    if (!max || !this.cache) return

    const key = `job-exceptions:${job.payload.uuid}`

    await this.cache.add(key, 0, 86_400)
    const thrown = Number(await this.cache.increment(key))

    if (max <= thrown) {
      await this.cache.forget(key)
      await this.fail(job, error)
    }
  }

  private async failIfWillExceed(
    job: QueuedJob,
    options: WorkerOptions,
    error: unknown
  ): Promise<void> {
    const maxTries = job.payload.maxTries ?? options.maxTries ?? 1
    const retryUntil = job.payload.retryUntil

    if (retryUntil && retryUntil <= Math.floor(Date.now() / 1000)) {
      await this.fail(job, error)
      return
    }

    if (!retryUntil && maxTries > 0 && job.attempts() >= maxTries) {
      await this.fail(job, error)
    }
  }

  /** Record the failure, tell the job, count it against any batch, and let go. */
  private async fail(job: QueuedJob, error: unknown): Promise<void> {
    await this.failed?.log(job.connectionName, job.queue, job.payload, error)

    // Before the reservation is dropped: the batch bookkeeping reads the payload,
    // and a driver is free to forget it afterwards.
    await this.runner.recordBatchFailure(job)

    // The job's own `failed()` hook runs before the reservation goes, so it can
    // still read the payload it was given.
    await this.callFailedHook(job, error)

    await job.fail(error)

    this.events?.dispatch('queue.job.failed', {
      job: job.payload.displayName,
      attempts: job.attempts(),
      error
    })
  }

  private async callFailedHook(job: QueuedJob, error: unknown): Promise<void> {
    try {
      const instance = await this.runner.resolve(job)

      await instance.failed(error)
    } catch {
      // A job whose class or data cannot be resolved still has to be recorded as
      // failed; swallowing this is the difference between a logged failure and a
      // worker that dies on a bad payload.
    }
  }

  private backoffFor(job: QueuedJob, options: WorkerOptions): number {
    const backoff = job.payload.backoff ?? options.backoff ?? 0

    if (typeof backoff === 'number') return backoff
    if (backoff.length === 0) return 0

    // Indexed by attempt, then held at the last value — `[5, 30, 120]` waits
    // five seconds, then thirty, then two minutes for every attempt after.
    return backoff[job.attempts() - 1] ?? backoff[backoff.length - 1] ?? 0
  }

  /**
   * Nothing to do: wait to be woken, or sleep if the driver cannot be.
   *
   * A driver that supports it holds a blocking read and returns the moment a job
   * arrives, so the wait between a push and its job starting is the push. One that
   * does not sleeps out the interval, which is where the whole three seconds came
   * from.
   *
   * Only the first queue is waited on. `high,default` means high wins, and blocking
   * on the whole list would mean waking for a low-priority job while a high one is
   * what the worker was told to prefer — the next poll checks every queue in order
   * anyway.
   */
  private async idle(queues: string[], sleep: number): Promise<void> {
    if (await this.driver.waitForJob?.(queues[0])) return

    await Bun.sleep(sleep * 1000)
  }

  private async reserve(queues: string[]): Promise<QueuedJob | null> {
    for (const queue of queues) {
      const job = await this.driver.pop(queue)

      if (job) return job
    }

    return null
  }

  /**
   * Has `queue:restart` been broadcast since this worker started?
   *
   * Checked between jobs, never during one: a restart that abandoned an
   * in-flight job would leave it reserved until its reservation expired, which
   * is the opposite of a graceful deploy.
   */
  private async shouldRestart(
    options: WorkerOptions,
    startedWith: number | undefined
  ): Promise<boolean> {
    if (!options.restartSignal) return false

    return (await options.restartSignal()) !== startedWith
  }

  /** True when any queue this worker serves has been paused. */
  private async isPaused(options: WorkerOptions, queues: string[]): Promise<boolean> {
    if (!options.pausedSignal) return false

    for (const queue of queues) {
      if (await options.pausedSignal(queue)) return true
    }

    return false
  }

  private exceededTime(startedAt: number, options: WorkerOptions): boolean {
    return Boolean(options.maxTime) && Date.now() - startedAt >= (options.maxTime ?? 0) * 1000
  }
}

export type Outcome = 'processed' | 'released' | 'failed'

/** Shape a failed-job record takes on the way out of `queue:failed`. */
export type FailedSummary = { id: string | number; job: string; queue: string; failedAt: Date }

export function summarise(payload: JobPayload): string {
  return payload.displayName
}
