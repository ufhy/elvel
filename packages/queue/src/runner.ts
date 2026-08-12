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
    const instance = await this.resolve(queued)

    await this.through(instance, () => Promise.resolve(instance.handle()))

    // A job that released or failed itself has said what should happen next; the
    // chain only continues after an attempt that actually succeeded.
    if (queued.isReleased() || queued.hasFailed()) return

    if (!queued.isDeleted()) await queued.delete()

    await this.releaseUniqueLock(queued.payload)
    await this.dispatchChain(queued)
  }

  /** Rebuild the job instance a payload names. */
  async resolve(queued: QueuedJob): Promise<AnyJob> {
    const jobClass = this.jobs.get(queued.payload.job)

    if (!jobClass) {
      throw new Error(
        `Job [${queued.payload.job}] is not registered. Jobs in app/Jobs are discovered automatically; anything else needs app.make('queue').jobs.register(TheJob).`
      )
    }

    const data = (await deserializeData(queued.payload.data, this.models)) as Record<
      string,
      unknown
    >

    // The constructor takes the same shape it was dispatched with, which is what
    // keeps a job readable: `new SendReport({ userId })`, not a bag of setters.
    const instance = new (jobClass as unknown as new (data: unknown) => AnyJob)(data)

    return instance.setQueuedJob(queued)
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
