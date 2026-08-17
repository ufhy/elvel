import { app } from '@elvel/core'
import type { AnyJob } from './job.ts'
import type { DispatchOptions, QueueManager } from './manager.ts'

/** The queue manager. */
export function queue(): QueueManager {
  return app('queue')
}

/**
 * Put a job on a queue.
 *
 * ```ts
 * await dispatch(new SendWelcomeEmail({ userId }))
 * await dispatch(new SendWelcomeEmail({ userId }), { delay: 60, queue: 'mail' })
 * ```
 */
export function dispatch(job: AnyJob, options?: DispatchOptions): Promise<string> {
  return queue().dispatch(job, options)
}

/** Run a job now, in this process, whatever the configured connection is. */
export function dispatchSync(job: AnyJob): Promise<void> {
  return queue().dispatchSync(job)
}

/** Dispatch jobs one after another, each only once its predecessor succeeded. */
export function chain(jobs: AnyJob[], options?: DispatchOptions): Promise<string | null> {
  return queue().chain(jobs, options)
}
