import type { JobPayload, QueueDriver, QueuedJob } from '../contracts.ts'

/**
 * A queue that discards everything.
 *
 * For an environment that must not run background work: a read-only replica, a
 * CI job that boots the application to check it boots, a maintenance process.
 * `sync` is the wrong answer there — it *runs* the job, which is exactly what
 * such an environment is trying to avoid — and leaving the queue misconfigured
 * throws on every dispatch.
 *
 * Discarding is silent and that is the point, but it is also the hazard: nothing
 * queued here ever happens. It is a deliberate configuration, never a fallback.
 */
export class NullQueue implements QueueDriver {
  readonly defaultQueue = 'null'

  constructor(readonly connectionName: string) {}

  async push(payload: JobPayload, _queue?: string): Promise<string> {
    return payload.uuid
  }

  async later(_delay: number, payload: JobPayload, _queue?: string): Promise<string> {
    return payload.uuid
  }

  async pop(_queue?: string): Promise<QueuedJob | null> {
    return null
  }

  async size(_queue?: string): Promise<number> {
    return 0
  }

  async clear(_queue?: string): Promise<number> {
    return 0
  }
}
