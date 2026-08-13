import type { Batch, BatchOptions, BatchRepository } from './batch.ts'
import type { AnyJob, JobClass } from './job.ts'

/** What the pending batch needs from the manager, without importing it. */
export type BatchDispatcher = {
  batches(): BatchRepository
  dispatch(
    job: AnyJob,
    options: { queue?: string; connection?: string; batchId?: string; chain?: AnyJob[] }
  ): Promise<string>
  jobs: { has(name: string): boolean; register(...jobs: JobClass[]): unknown }
}

/**
 * A batch being described — `Illuminate\Bus\PendingBatch`.
 *
 * ```ts
 * await bus()
 *   .batch([new ImportRow(1), new ImportRow(2)])
 *   .name('nightly import')
 *   .then(NotifyImportFinished)
 *   .catch(AlertOncall)
 *   .dispatch()
 * ```
 *
 * The callbacks are **job classes**, not closures. Laravel serialises closures
 * into the batch row; a closure cannot be rebuilt in the worker that would run it,
 * which is the same wall queued listeners hit. Naming a job is the honest version
 * of the same idea — and it means a callback gets retries and a failure record
 * like anything else that runs in a worker.
 */
/**
 * One entry in a batch: a job, or an array of jobs meaning "these in order".
 *
 * A chain inside a batch is how you say "each of these ten imports has to run
 * its own three steps in order, but the ten do not wait for each other" — which
 * is most bulk work, and neither a plain batch nor a plain chain expresses it.
 */
export type BatchEntry = AnyJob | AnyJob[]

export class PendingBatch {
  private batchName = ''
  private readonly options: BatchOptions = {}

  constructor(
    private readonly dispatcher: BatchDispatcher,
    private readonly jobs: BatchEntry[]
  ) {}

  name(name: string): this {
    this.batchName = name

    return this
  }

  /**
   * Dispatched, with the batch id, once every job has succeeded.
   *
   * Laravel calls this `then`. It cannot be called that here: a class with a
   * `then` member is a thenable, so `await queue().batch([...])` would invoke it
   * with `resolve`/`reject` instead of job classes — a chainable builder must not
   * be mistakable for a promise. The scheduler dropped its own `then()` alias for
   * exactly this, and the linter caught this one.
   */
  onSuccess(...jobs: JobClass[]): this {
    this.options.onSuccess = [...(this.options.onSuccess ?? []), ...this.register(jobs)]

    return this
  }

  /** Dispatched on the first failure — Laravel's `catch`. */
  onFailure(...jobs: JobClass[]): this {
    this.options.onFailure = [...(this.options.onFailure ?? []), ...this.register(jobs)]

    return this
  }

  /** Dispatched once every job has run exactly once, whatever the outcome. */
  onFinished(...jobs: JobClass[]): this {
    this.options.onFinished = [...(this.options.onFinished ?? []), ...this.register(jobs)]

    return this
  }

  /**
   * Keep going after a failure.
   *
   * Off by default, as Laravel has it: a batch usually describes one piece of
   * work, and continuing to import rows after the first one failed produces a
   * half-finished result nobody asked for.
   */
  allowFailures(allow = true): this {
    this.options.allowFailures = allow

    return this
  }

  onQueue(queue: string): this {
    this.options.queue = queue

    return this
  }

  onConnection(connection: string): this {
    this.options.connection = connection

    return this
  }

  /** Store the batch, then queue every job with its id attached. */
  async dispatch(): Promise<Batch> {
    /**
     * A chain counts as all of its links, not as one job.
     *
     * The batch is finished when every link has run: each carries the batch id
     * and decrements the count as it succeeds, so a total of one per chain would
     * fire `onSuccess` while most of the work was still queued.
     */
    const total = this.jobs.reduce<number>(
      (count, entry) => count + (Array.isArray(entry) ? entry.length : 1),
      0
    )

    const batch = await this.dispatcher.batches().store({
      id: crypto.randomUUID(),
      name: this.batchName,
      totalJobs: total,
      pendingJobs: total,
      failedJobs: 0,
      failedJobIds: [],
      options: this.options,
      createdAt: Math.floor(Date.now() / 1000)
    })

    // Stored before anything is queued, on purpose: a worker fast enough to
    // reserve the first job before the row exists would have nothing to count
    // against.
    for (const entry of this.jobs) {
      // Only the head of a chain is queued; the rest travel in its payload and
      // are dispatched one at a time as each predecessor succeeds.
      const [first, ...rest] = Array.isArray(entry) ? entry : [entry]
      if (!first) continue

      await this.dispatcher.dispatch(first, {
        batchId: batch.id,
        ...(rest.length > 0 ? { chain: rest } : {}),
        ...(this.options.queue ? { queue: this.options.queue } : {}),
        ...(this.options.connection ? { connection: this.options.connection } : {})
      })
    }

    return batch
  }

  /** A callback job has to be resolvable by name in the worker that runs it. */
  private register(jobs: JobClass[]): string[] {
    for (const job of jobs) {
      if (!this.dispatcher.jobs.has(job.name)) this.dispatcher.jobs.register(job)
    }

    return jobs.map((job) => job.name)
  }
}
