import type { BatchRepository } from './batch.ts'
import type { JobPayload, QueuedJob } from './contracts.ts'
import type { AnyJob, JobMiddleware, JobRegistry } from './job.ts'
import { deserializeData, type ModelRegistry } from './serializer.ts'

/** Dispatches the next link of a chain once a job succeeds. */
export type ChainDispatcher = (
  payload: JobPayload,
  connection: string,
  queue: string
) => Promise<void>

export type JobRunnerOptions = {
  chain?: ChainDispatcher
  /** Cache repository used to release a unique job's lock, when one was taken. */
  locks?: { forget(key: string): Promise<boolean> }
  /** Needed only for a job whose payload was encrypted. */
  encrypter?: { decrypt<T>(payload: string, context?: string): T }
  /** Where batches are counted. Absent when nothing batches. */
  batches?: BatchRepository
  /** Dispatches a batch callback by name, once the batch reaches an outcome. */
  dispatchCallback?: (job: string, batchId: string) => Promise<unknown>
}

/**
 * Turns a payload back into a job and runs it — Laravel's `CallQueuedHandler`.
 *
 * Kept apart from the worker on purpose: this half knows about jobs, middleware
 * and chains, and the worker half knows about reservations, retries and failures.
 * Running a job by hand — `dispatchSync`, or a test — needs only this.
 */
export class JobRunner {
  constructor(
    private readonly jobs: JobRegistry,
    private readonly models: ModelRegistry,
    private readonly options: JobRunnerOptions = {}
  ) {}

  /** Resolve, run, then delete the reservation and start any chain. */
  async run(queued: QueuedJob): Promise<void> {
    /**
     * A cancelled batch's remaining jobs are dropped, not run.
     *
     * They cannot be deleted from the queue when the batch is cancelled — a driver
     * has no random access, and another worker may already hold one — so the check
     * happens here, at the moment of reservation. Laravel does the same.
     */
    if (await this.batchWasCancelled(queued)) {
      if (!queued.isDeleted()) await queued.delete()

      return
    }

    const instance = await this.resolve(queued)

    await this.through(instance, () => Promise.resolve(instance.handle()))

    // A job that released or failed itself has said what should happen next; the
    // chain only continues after an attempt that actually succeeded.
    if (queued.isReleased() || queued.hasFailed()) return

    if (!queued.isDeleted()) await queued.delete()

    await this.releaseUniqueLock(queued.payload)
    await this.recordBatchSuccess(queued)
    await this.dispatchChain(queued)
  }

  private async batchWasCancelled(queued: QueuedJob): Promise<boolean> {
    const id = queued.payload.batchId
    if (!id || !this.options.batches) return false

    const batch = await this.options.batches.find(id)

    return batch?.cancelled === true
  }

  /** Count a success, and fire `then`/`finally` when the batch is done. */
  private async recordBatchSuccess(queued: QueuedJob): Promise<void> {
    const id = queued.payload.batchId
    if (!id || !this.options.batches) return

    const batch = await this.options.batches.recordSuccess(id, queued.payload.uuid)
    if (!batch || batch.pendingJobs > 0) return

    // Success only when nothing failed; finished either way, which is the whole
    // distinction between them.
    if (batch.failedJobs === 0) await this.fireCallbacks(batch.record.options.onSuccess, id)

    await this.fireCallbacks(batch.record.options.onFinished, id)
  }

  /**
   * Count a failure. Called by the worker once a job has failed for the last time.
   *
   * The first failure cancels the batch unless it allows failures — otherwise the
   * rest of the work carries on producing a half-finished result.
   */
  async recordBatchFailure(queued: QueuedJob): Promise<void> {
    const id = queued.payload.batchId
    if (!id || !this.options.batches) return

    const batch = await this.options.batches.recordFailure(id, queued.payload.uuid)
    if (!batch) return

    if (batch.failedJobs === 1) {
      if (!batch.record.options.allowFailures) await this.options.batches.cancel(id)

      await this.fireCallbacks(batch.record.options.onFailure, id)
    }

    if (batch.pendingJobs === 0) await this.fireCallbacks(batch.record.options.onFinished, id)
  }

  private async fireCallbacks(jobs: string[] | undefined, batchId: string): Promise<void> {
    if (!jobs || !this.options.dispatchCallback) return

    for (const job of jobs) await this.options.dispatchCallback(job, batchId)
  }

  /** Rebuild the job instance a payload names. */
  async resolve(queued: QueuedJob): Promise<AnyJob> {
    const jobClass = this.jobs.get(queued.payload.job)

    if (!jobClass) {
      throw new Error(
        `Job [${queued.payload.job}] is not registered. Jobs in app/Jobs are discovered automatically; anything else needs app.make('queue').jobs.register(TheJob).`
      )
    }

    // An encrypted payload is recovered first: what follows expects the job's own
    // fields, not the envelope they travelled in.
    const stored = queued.payload.encrypted
      ? this.decryptPayload(queued.payload)
      : this.decryptFields(queued.payload)

    const data = (await deserializeData(stored, this.models)) as Record<string, unknown>

    // The constructor takes the same shape it was dispatched with, which is what
    // keeps a job readable: `new SendReport({ userId })`, not a bag of setters.
    const instance = new (jobClass as unknown as new (data: unknown) => AnyJob)(data)

    return instance.setQueuedJob(queued)
  }

  /**
   * Recover the data of an encrypted payload.
   *
   * The job's name is the context it was encrypted with, so a ciphertext written
   * for another job fails here rather than running with someone else's data.
   */
  /**
   * Decrypt the fields a job named, leaving the rest as they are.
   *
   * The list travels in the payload rather than being read from the class: a
   * worker may be running an older copy of the code, and decrypting by today's
   * list would mangle a payload written by yesterday's.
   */
  private decryptFields(payload: JobPayload): Record<string, unknown> {
    const data = { ...(payload.data as Record<string, unknown>) }
    const fields = data.__encryptedFields

    if (!Array.isArray(fields)) return data

    if (!this.options.encrypter) {
      throw new Error(
        `Job [${payload.job}] has encrypted fields but no encrypter is registered. Register EncryptionServiceProvider.`
      )
    }

    for (const field of fields as string[]) {
      const value = data[field]

      if (typeof value !== 'string') continue

      data[field] = this.options.encrypter.decrypt(value, `job:${payload.job}:${field}`)
    }

    delete data.__encryptedFields

    return data
  }

  private decryptPayload(payload: JobPayload): Record<string, unknown> {
    if (!this.options.encrypter) {
      throw new Error(
        `Job [${payload.job}] has an encrypted payload but no encrypter is registered. Register EncryptionServiceProvider.`
      )
    }

    const ciphertext = (payload.data as { __encrypted?: unknown }).__encrypted

    if (typeof ciphertext !== 'string') {
      throw new Error(`Job [${payload.job}] is marked encrypted but carries no ciphertext.`)
    }

    return this.options.encrypter.decrypt<Record<string, unknown>>(ciphertext, `job:${payload.job}`)
  }

  /** Run `handle()` through the job's middleware, innermost last. */
  private async through(job: AnyJob, handle: () => Promise<void>): Promise<void> {
    const middleware = job.middleware()

    const pipeline = middleware.reduceRight<() => Promise<void>>(
      (next, layer: JobMiddleware) => () => layer.handle(job, next),
      handle
    )

    await pipeline()
  }

  private async dispatchChain(queued: QueuedJob): Promise<void> {
    const [next, ...rest] = queued.payload.chain ?? []
    if (!next || !this.options.chain) return

    await this.options.chain(
      { ...next, chain: rest },
      queued.connectionName,
      // The chain stays on the queue it was dispatched to unless a link says
      // otherwise, so a chain cannot quietly jump to a queue nobody works.
      queued.queue
    )
  }

  /**
   * A unique job holds its lock until it has run, not until it was reserved:
   * releasing it earlier would let a duplicate be queued while the first is still
   * working.
   */
  private async releaseUniqueLock(payload: JobPayload): Promise<void> {
    const key = uniqueKeyOf(payload)
    if (!key || !this.options.locks) return

    await this.options.locks.forget(key)
  }
}

/** The cache key a unique job occupies, or null when it is not unique. */
export function uniqueKeyOf(payload: JobPayload): string | null {
  const unique = (payload.data as { __unique?: unknown }).__unique

  return typeof unique === 'string' ? unique : null
}
