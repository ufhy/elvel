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
