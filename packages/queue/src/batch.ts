import type { ApplicationContract } from '@elysian/contracts'
import type { QueryBuilder, Row } from '@elysian/database'

/** A batch as it sits in the table. */
export type BatchRecord = {
  id: string
  name: string
  totalJobs: number
  pendingJobs: number
  failedJobs: number
  failedJobIds: string[]
  /** Job classes to dispatch when the batch reaches each outcome. */
  options: BatchOptions
  cancelledAt?: number | undefined
  createdAt: number
  finishedAt?: number | undefined
}

export type BatchOptions = {
  /**
   * Dispatched when every job succeeded.
   *
   * Named `onSuccess` rather than `then`, and the reason is not taste: an object
   * with a `then` member **is** a thenable, so `await queue().batch([...])` would
   * call it with `resolve` and `reject` where job classes are expected. The
   * scheduler dropped its own `then()` alias for the same reason.
   */
  onSuccess?: string[]
  /** Dispatched on the first failure. */
  onFailure?: string[]
  /** Dispatched once every job has run exactly once, whatever the outcome. */
  onFinished?: string[]
  /** A failure cancels the rest of the batch unless this is on. */
  allowFailures?: boolean
  connection?: string
  queue?: string
}

/**
 * A batch of jobs, and the counters that say how far along it is.
 *
 * The one real departure from Laravel: **callbacks are job classes, not
 * closures.** Laravel serialises the closures into the batch row; a closure here
 * cannot travel to the worker that would run it, for exactly the reason a queued
 * listener is a class. So `onSuccess(SendReport)` dispatches `SendReport` — with the
 * batch id in its payload — instead of calling a function nobody can rebuild.
 */
export class Batch {
  constructor(
    readonly record: BatchRecord,
    private readonly repository: BatchRepository
  ) {}

  get id(): string {
    return this.record.id
  }

  get name(): string {
    return this.record.name
  }

  get totalJobs(): number {
    return this.record.totalJobs
  }

  get pendingJobs(): number {
    return this.record.pendingJobs
  }

  get processedJobs(): number {
    return this.record.totalJobs - this.record.pendingJobs
  }

  get failedJobs(): number {
    return this.record.failedJobs
  }

  /** 0–100, rounded down. A batch of nothing is complete by definition. */
  get progress(): number {
    if (this.record.totalJobs === 0) return 100

    return Math.floor((this.processedJobs / this.record.totalJobs) * 100)
  }

  get finished(): boolean {
    return this.record.finishedAt !== undefined
  }

  get cancelled(): boolean {
    return this.record.cancelledAt !== undefined
  }

  /**
   * Stop the rest of the batch.
   *
   * Jobs already queued are not deleted — a worker cannot reach into another
   * queue and remove them. They are skipped when reserved instead, which is
   * Laravel's approach and the only one that works with a driver that has no
   * random access.
   */
  async cancel(): Promise<void> {
    await this.repository.cancel(this.id)
  }

  async fresh(): Promise<Batch | undefined> {
    return this.repository.find(this.id)
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      totalJobs: this.totalJobs,
      pendingJobs: this.pendingJobs,
      processedJobs: this.processedJobs,
      failedJobs: this.failedJobs,
      progress: this.progress,
      finished: this.finished,
      cancelled: this.cancelled
    }
  }
}

/** What the runner and the bus need from wherever batches are kept. */
export interface BatchRepository {
  store(record: BatchRecord): Promise<Batch>
  find(id: string): Promise<Batch | undefined>
  /** Decrement the pending count; returns the batch as it now stands. */
  recordSuccess(id: string, jobId: string): Promise<Batch | undefined>
  /** Increment the failure count and record the job id. */
  recordFailure(id: string, jobId: string): Promise<Batch | undefined>
  cancel(id: string): Promise<void>
  /** Forget finished batches older than this many seconds. */
  prune(olderThanSeconds: number): Promise<number>

  /**
   * Drop batches that never finished.
   *
   * Separate from `prune` because "finished" is the normal end and this is not:
   * a batch is left unfinished by a worker that died mid-run, or by a job that
   * failed with `allowFailures` off. Keeping them is how you notice; keeping them
   * for ever is how the table grows without bound.
   */
  pruneUnfinished(olderThanSeconds: number): Promise<number>

  /**
   * Drop cancelled batches.
   *
   * These need their own sweep because a cancelled batch never finishes by
   * design: its remaining jobs are skipped as they are reserved, so the pending
   * count stays above zero for work that will never run. Without this they
   * accumulate for ever, and `prune` — which only takes finished ones — never
   * touches them.
   */
  pruneCancelled(olderThanSeconds: number): Promise<number>
}

/** Batches in memory. The `sync` connection's, and every test's. */
export class ArrayBatchRepository implements BatchRepository {
  private readonly batches = new Map<string, BatchRecord>()

  async store(record: BatchRecord): Promise<Batch> {
    this.batches.set(record.id, { ...record })

    return new Batch({ ...record }, this)
  }

  async find(id: string): Promise<Batch | undefined> {
    const record = this.batches.get(id)

    return record ? new Batch({ ...record }, this) : undefined
  }

  async recordSuccess(id: string, jobId: string): Promise<Batch | undefined> {
    void jobId
    const record = this.batches.get(id)
    if (!record) return undefined

    record.pendingJobs = Math.max(0, record.pendingJobs - 1)
    if (record.pendingJobs === 0) record.finishedAt ??= now()

    return new Batch({ ...record }, this)
  }

  async recordFailure(id: string, jobId: string): Promise<Batch | undefined> {
    const record = this.batches.get(id)
    if (!record) return undefined

    record.pendingJobs = Math.max(0, record.pendingJobs - 1)
    record.failedJobs += 1
    record.failedJobIds = [...record.failedJobIds, jobId]
    if (record.pendingJobs === 0) record.finishedAt ??= now()

    return new Batch({ ...record }, this)
  }

  async cancel(id: string): Promise<void> {
    const record = this.batches.get(id)
    if (!record) return

    record.cancelledAt ??= now()
  }

  async prune(olderThanSeconds: number): Promise<number> {
    return this.sweep(
      olderThanSeconds,
      (record, cutoff) => record.finishedAt !== undefined && record.finishedAt < cutoff
    )
  }

  async pruneUnfinished(olderThanSeconds: number): Promise<number> {
    return this.sweep(
      olderThanSeconds,
      (record, cutoff) => record.finishedAt === undefined && record.createdAt < cutoff
    )
  }

  async pruneCancelled(olderThanSeconds: number): Promise<number> {
    return this.sweep(
      olderThanSeconds,
      (record, cutoff) => record.cancelledAt !== undefined && record.createdAt < cutoff
    )
  }

  private sweep(
    olderThanSeconds: number,
    matches: (record: BatchRecord, cutoff: number) => boolean
  ): number {
    const cutoff = now() - olderThanSeconds
    let removed = 0

    for (const [id, record] of this.batches) {
      if (matches(record, cutoff)) {
        this.batches.delete(id)
        removed += 1
      }
    }

    return removed
  }
}

/** Batches in a table, so several workers agree on the counts. */
export class DatabaseBatchRepository implements BatchRepository {
  constructor(
    private readonly app: ApplicationContract,
    private readonly table = 'job_batches',
    private readonly connection?: string
  ) {}

  private async query(): Promise<QueryBuilder<Row>> {
    return this.app.make('db').table(this.table, this.connection)
  }

  async store(record: BatchRecord): Promise<Batch> {
    await (await this.query()).insert({
      id: record.id,
      name: record.name,
      total_jobs: record.totalJobs,
      pending_jobs: record.pendingJobs,
      failed_jobs: record.failedJobs,
      failed_job_ids: JSON.stringify(record.failedJobIds),
      options: JSON.stringify(record.options),
      cancelled_at: record.cancelledAt ?? null,
      created_at: record.createdAt,
      finished_at: record.finishedAt ?? null
    })

    return new Batch(record, this)
  }

  async find(id: string): Promise<Batch | undefined> {
    const row = await (await this.query()).where('id', id).first()

    return row ? new Batch(hydrate(row), this) : undefined
  }

  async recordSuccess(id: string, jobId: string): Promise<Batch | undefined> {
    void jobId

    await (await this.query()).where('id', id).decrement('pending_jobs')

    return this.finishIfDone(id)
  }

  async recordFailure(id: string, jobId: string): Promise<Batch | undefined> {
    const current = await this.find(id)
    if (!current) return undefined

    await (await this.query()).where('id', id).update({
      pending_jobs: Math.max(0, current.pendingJobs - 1),
      failed_jobs: current.failedJobs + 1,
      failed_job_ids: JSON.stringify([...current.record.failedJobIds, jobId])
    })

    return this.finishIfDone(id)
  }

  /**
   * Stamp `finished_at` once nothing is pending.
   *
   * Written only if it is still null, so two workers finishing the last two jobs
   * at once cannot both claim to have ended the batch.
   */
  private async finishIfDone(id: string): Promise<Batch | undefined> {
    const batch = await this.find(id)
    if (!batch) return undefined

    if (batch.pendingJobs > 0 || batch.finished) return batch

    await (await this.query())
      .where('id', id)
      .whereNull('finished_at')
      .update({ finished_at: now() })

    return this.find(id)
  }

  async cancel(id: string): Promise<void> {
    await (await this.query())
      .where('id', id)
      .whereNull('cancelled_at')
      .update({ cancelled_at: now() })
  }

  async prune(olderThanSeconds: number): Promise<number> {
    return (await this.query())
      .whereNotNull('finished_at')
      .where('finished_at', '<', now() - olderThanSeconds)
      .delete()
  }

  async pruneUnfinished(olderThanSeconds: number): Promise<number> {
    // Aged by `created_at`: an unfinished batch has no `finished_at` to age by,
    // which is the whole reason it needs its own sweep.
    return (await this.query())
      .whereNull('finished_at')
      .where('created_at', '<', now() - olderThanSeconds)
      .delete()
  }

  async pruneCancelled(olderThanSeconds: number): Promise<number> {
    return (await this.query())
      .whereNotNull('cancelled_at')
      .where('created_at', '<', now() - olderThanSeconds)
      .delete()
  }
}

function hydrate(row: Row): BatchRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    totalJobs: Number(row.total_jobs ?? 0),
    pendingJobs: Number(row.pending_jobs ?? 0),
    failedJobs: Number(row.failed_jobs ?? 0),
    failedJobIds: parse<string[]>(row.failed_job_ids, []),
    options: parse<BatchOptions>(row.options, {}),
    cancelledAt: row.cancelled_at === null ? undefined : Number(row.cancelled_at),
    createdAt: Number(row.created_at ?? 0),
    finishedAt: row.finished_at === null ? undefined : Number(row.finished_at)
  }
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value as T) ?? fallback

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}
