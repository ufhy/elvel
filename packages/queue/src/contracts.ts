import type { SerialisedContext } from '@elvel/core'

/** The serialised form of a queued job, as it sits in the store. */
export type JobPayload = {
  /** Stable identity across releases and retries. */
  uuid: string
  /** Name the job is registered under — how the worker finds the class. */
  job: string
  /** Human-readable name for logs and `queue:failed`. */
  displayName: string
  /** Constructor data, with model references already encoded. */
  data: Record<string, unknown>
  /** Times this payload has been reserved. Incremented by the driver. */
  attempts: number
  maxTries?: number | undefined
  maxExceptions?: number | undefined
  /** Seconds to wait before a retry; a list is indexed by attempt. */
  backoff?: number | number[] | undefined
  /** Seconds a single attempt may run. */
  timeout?: number | undefined
  /** Fail a timed-out attempt outright, rather than retrying it. */
  failOnTimeout?: boolean | undefined
  /** UNIX timestamp after which no further attempt is made. */
  retryUntil?: number | undefined
  /** Jobs to dispatch once this one succeeds. */
  chain?: JobPayload[] | undefined

  /**
   * Job classes dispatched when a link of this chain fails.
   *
   * Without it a broken link stops the rest and only that job's own `failed()`
   * fires — nothing is told the chain died, which is the one thing a chain's
   * caller wants to know.
   *
   * Carried on every link so a failure five deep still knows who to tell.
   */
  chainCatch?: string[] | undefined
  /**
   * The batch this job belongs to, if any.
   *
   * In the payload rather than on the class: a batch is decided when the job is
   * dispatched, and the worker that runs it has only the payload to go on.
   */
  batchId?: string | undefined
  /**
   * Set when `data` holds a ciphertext rather than the job's own fields.
   *
   * In the payload rather than read from the class, so a worker running an older
   * copy of the code still knows what it is looking at.
   */
  encrypted?: boolean | undefined
  /**
   * The dispatching unit of work's context, carried to the worker.
   *
   * What makes "this job failed" traceable back to "this request caused it"
   * without threading an id through every job's constructor.
   */
  context?: SerialisedContext | undefined
  createdAt: number
}

/**
 * A job the worker has reserved.
 *
 * The three outcomes are exclusive and the worker checks which one happened:
 * a job that deleted, released or failed itself must not be released again.
 */
export interface QueuedJob {
  readonly payload: JobPayload
  readonly queue: string
  readonly connectionName: string

  /** Attempts *including* this one. */
  attempts(): number

  /** Done: remove it from the store. */
  delete(): Promise<void>

  /** Put it back, optionally after a delay. */
  release(delay?: number): Promise<void>

  /** Give up: move it to the failed store. */
  fail(error: unknown): Promise<void>

  isDeleted(): boolean
  isReleased(): boolean
  hasFailed(): boolean
}

/** What every queue driver provides. */
export interface QueueDriver {
  readonly connectionName: string

  /** The queue used when none is named. */
  readonly defaultQueue: string

  push(payload: JobPayload, queue?: string): Promise<string>

  /** Push, but not available until `delay` seconds have passed. */
  later(delay: number, payload: JobPayload, queue?: string): Promise<string>

  /**
   * Push many at once, where the driver can.
   *
   * A batch of a thousand rows was a thousand inserts, one at a time, inside the
   * request that created it. Optional, because a driver that cannot do it in one
   * step should not pretend to — the caller loops, which is what this replaces.
   */
  pushMany?(payloads: JobPayload[], queue?: string): Promise<string[]>

  /** Reserve the next available job, or null when the queue is empty. */
  pop(queue?: string): Promise<QueuedJob | null>

  size(queue?: string): Promise<number>

  clear(queue?: string): Promise<number>

  /**
   * Wait for work instead of polling for it, if this driver can.
   *
   * An idle worker sleeps between polls, so a job pushed just after a poll waits
   * out the whole interval before anything looks again — three seconds by default.
   * A driver that can be woken says so by returning `true`, having already waited;
   * `false` (or no method at all) means the worker should sleep as before.
   *
   * It may return before there is anything to take. A wake-up is a hint to look,
   * never a promise, so the caller loops rather than assuming.
   */
  waitForJob?(queue?: string): Promise<boolean>
}

/** Where failed jobs go. */
export interface FailedJobStore {
  log(
    connection: string,
    queue: string,
    payload: JobPayload,
    error: unknown
  ): Promise<string | number>

  all(): Promise<FailedJobRecord[]>

  find(id: string | number): Promise<FailedJobRecord | null>

  forget(id: string | number): Promise<boolean>

  flush(hours?: number): Promise<number>
}

export type FailedJobRecord = {
  id: string | number
  uuid: string
  connection: string
  queue: string
  payload: JobPayload
  exception: string
  failedAt: Date
}
