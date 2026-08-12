import type { JobPayload, QueueDriver, QueuedJob } from '../contracts.ts'

/** Runs a payload where it stands. Supplied by the manager. */
export type SyncRunner = (job: QueuedJob) => Promise<void>

/**
 * No queue at all — `Illuminate\Queue\SyncQueue`.
 *
 * The job runs inside `push()`, before the dispatcher returns. That makes it the
 * right default for local development and for tests, where a background worker
 * would mean the assertions run before the work does. It also means a failing job
 * throws into the caller, which is what you want while writing it.
 *
 * `later()` does not wait: a delay has no meaning without something to wait *in*.
 */
export class SyncQueue implements QueueDriver {
  readonly defaultQueue = 'sync'

  constructor(
    readonly connectionName: string,
    private readonly run: SyncRunner
  ) {}

  async push(payload: JobPayload, queue?: string): Promise<string> {
    await this.run(new SyncJob(payload, queue ?? this.defaultQueue, this.connectionName))

    return payload.uuid
  }

  async later(_delay: number, payload: JobPayload, queue?: string): Promise<string> {
    return this.push(payload, queue)
  }

  /** Nothing is ever waiting: the queue is always empty. */
  async pop(): Promise<QueuedJob | null> {
    return null
  }

  async size(): Promise<number> {
    return 0
  }

  async clear(): Promise<number> {
    return 0
  }
}

class SyncJob implements QueuedJob {
  private deleted = false
  private released = false
  private failed = false

  constructor(
    readonly payload: JobPayload,
    readonly queue: string,
    readonly connectionName: string
  ) {}

  /** Always its first and only attempt. */
  attempts(): number {
    return 1
  }

  async delete(): Promise<void> {
    this.deleted = true
  }

  /**
   * There is nowhere to release to.
   *
   * Marked as released so the worker's bookkeeping stays honest — it will not
   * then try to release it again — but the job simply does not run a second time.
   */
  async release(): Promise<void> {
    this.released = true
  }

  async fail(): Promise<void> {
    this.failed = true
  }

  isDeleted(): boolean {
    return this.deleted
  }

  isReleased(): boolean {
    return this.released
  }

  hasFailed(): boolean {
    return this.failed
  }
}
