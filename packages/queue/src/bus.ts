import type { Batch, BatchOptions, BatchRepository } from './batch.ts'
import type { AnyJob, JobClass } from './job.ts'

/** What the pending batch needs from the manager, without importing it. */
export type BatchDispatcher = {
  batches(): BatchRepository
  dispatch(
    job: AnyJob,
    options: { queue?: string; connection?: string; batchId?: string; chain?: AnyJob[] }
  ): Promise<string>
  /**
   * Optional: a fake has no driver to push many into, and one round trip is not
   * something a test needs. Absent, the batch dispatches one at a time.
   */
  bulk?(
    jobs: AnyJob[],
    options: { queue?: string; connection?: string; batchId?: string }
  ): Promise<string[]>

  jobs: { has(name: string): boolean; register(...jobs: JobClass[]): unknown }

  /**
   * Optional: not every dispatcher has events, and the fake has none at all.
   * A batch that nobody is watching is still a batch.
   */
  notify?(event: string, payload: Record<string, unknown>): void
}

/**
 * A batch being described.
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
 * The callbacks are **job classes**, not closures. A closure cannot be rebuilt in
 * the worker that would run it,
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
   * It cannot be called `then`: a class with a
   * `then` member is a thenable, so `await queue().batch([...])` would invoke it
   * with `resolve`/`reject` instead of job classes — a chainable builder must not
   * be mistakable for a promise. The scheduler dropped its own `then()` alias for
   * exactly this, and the linter caught this one.
   */
  onSuccess(...jobs: JobClass[]): this {
    this.options.onSuccess = [...(this.options.onSuccess ?? []), ...this.register(jobs)]

    return this
  }

  /** Dispatched on the first failure. */
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
   * Off by default it: a batch usually describes one piece of
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

    /**
     * Announced once the row exists and before the jobs go out.
     *
     * Before, so a recorder files the batch in the same unit of work that
     * created it and ahead of the jobs that will name it — a batch entry that
     * arrived after its own jobs would read as though the jobs came first.
     */
    this.dispatcher.notify?.('queue.batch.dispatched', {
      batchId: batch.id,
      name: batch.name,
      totalJobs: batch.totalJobs,
      queue: this.options.queue ?? null,
      connection: this.options.connection ?? null
    })

    // Stored before anything is queued, on purpose: a worker fast enough to
    // reserve the first job before the row exists would have nothing to count
    // against.
    const shared = {
      batchId: batch.id,
      ...(this.options.queue ? { queue: this.options.queue } : {}),
      ...(this.options.connection ? { connection: this.options.connection } : {})
    }

    /**
     * Runs of plain jobs go out together; a chain interrupts the run.
     *
     * Only the head of a chain is queued — the rest travel in its payload and
     * are dispatched as each predecessor succeeds — so a chain's head carries a
     * payload of its own and cannot join a bulk push.
     *
     * The pending run is flushed *before* each chain rather than collected and
     * pushed at the end, so the jobs reach the queue in the order they were
     * declared. A batch makes no promise about order, but silently changing the
     * one an application already sees is not this change's business.
     */
    let run: AnyJob[] = []

    const flush = async (): Promise<void> => {
      if (run.length === 0) return

      if (this.dispatcher.bulk !== undefined) await this.dispatcher.bulk(run, shared)
      else for (const job of run) await this.dispatcher.dispatch(job, shared)

      run = []
    }

    for (const entry of this.jobs) {
      if (!Array.isArray(entry)) {
        run.push(entry)

        continue
      }

      const [first, ...rest] = entry
      if (!first) continue

      await flush()

      await this.dispatcher.dispatch(first, {
        ...shared,
        ...(rest.length > 0 ? { chain: rest } : {})
      })
    }

    await flush()

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
