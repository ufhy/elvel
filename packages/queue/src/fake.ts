import type { JobPayload, QueueDriver, QueuedJob } from './contracts.ts'

/** One thing that was pushed, with where it was pushed to. */
export type PushedJob = {
  connection: string
  queue: string
  payload: JobPayload
  /** Seconds it was delayed by, or 0. */
  delay: number
}

/**
 * A queue driver that records instead of queueing — Laravel's `Queue::fake()`.
 *
 * The problem it solves is that `sync` is not a fake. Running the job inline
 * proves the job works, which is a different question from "did the controller
 * dispatch it", and a job that sends mail or charges a card runs for real. This
 * accepts the push and keeps it.
 *
 * `pop()` always answers null: a faked queue is one nothing works off, and a
 * worker started against it would find the recorded jobs and run them, which is
 * the thing being avoided.
 */
export class FakeQueue implements QueueDriver {
  readonly pushed: PushedJob[] = []

  constructor(
    readonly connectionName: string,
    readonly defaultQueue: string
  ) {}

  async push(payload: JobPayload, queue?: string): Promise<string> {
    this.record(payload, queue, 0)

    return payload.uuid
  }

  async later(delay: number, payload: JobPayload, queue?: string): Promise<string> {
    this.record(payload, queue, delay)

    return payload.uuid
  }

  async pop(): Promise<QueuedJob | null> {
    return null
  }

  async size(queue?: string): Promise<number> {
    return this.jobsOn(queue).length
  }

  async clear(queue?: string): Promise<number> {
    const kept = this.pushed.filter((job) => job.queue !== (queue ?? this.defaultQueue))
    const removed = this.pushed.length - kept.length

    this.pushed.length = 0
    this.pushed.push(...kept)

    return removed
  }

  private record(payload: JobPayload, queue: string | undefined, delay: number): void {
    this.pushed.push({
      connection: this.connectionName,
      queue: queue ?? this.defaultQueue,
      payload,
      delay
    })
  }

  private jobsOn(queue?: string): PushedJob[] {
    return queue === undefined ? this.pushed : this.pushed.filter((job) => job.queue === queue)
  }
}

/**
 * The assertions — `Queue::assertPushed()` and its relatives.
 *
 * Kept apart from the driver so the driver stays a plain `QueueDriver`: the
 * manager resolves it like any other, and nothing in the dispatch path knows it
 * is being watched.
 */
export class QueueFake {
  constructor(private readonly driver: FakeQueue) {}

  /** Everything pushed, oldest first. */
  pushed(job?: string): PushedJob[] {
    return job === undefined
      ? [...this.driver.pushed]
      : this.driver.pushed.filter((one) => one.payload.job === job)
  }

  /**
   * Returns the first match, so a check can carry on into the payload.
   *
   * ```ts
   * const pushed = fake.assertPushed('SendArticleDigest')
   * expect(pushed.payload.data.articleId).toBe(7)
   * ```
   */
  assertPushed(job: string, matching?: (pushed: PushedJob) => boolean): PushedJob {
    const matches = this.pushed(job).filter((one) => matching?.(one) ?? true)
    const first = matches[0]

    if (first === undefined) {
      throw new Error(
        `Expected [${job}] to have been pushed${matching ? ' matching the callback' : ''}, but it was not. Pushed: ${this.summary()}`
      )
    }

    return first
  }

  assertNotPushed(job: string): this {
    if (this.pushed(job).length > 0) {
      throw new Error(`Expected [${job}] not to have been pushed, but it was.`)
    }

    return this
  }

  assertPushedTimes(job: string, times: number): this {
    const actual = this.pushed(job).length

    if (actual !== times) {
      throw new Error(
        `Expected [${job}] to be pushed ${times} time(s), but it was pushed ${actual}.`
      )
    }

    return this
  }

  /** The queue it landed on, which is where a `high`/`low` split goes wrong. */
  assertPushedOn(queue: string, job: string): this {
    if (!this.pushed(job).some((one) => one.queue === queue)) {
      throw new Error(
        `Expected [${job}] on queue [${queue}]. Saw: ${
          this.pushed(job)
            .map((one) => one.queue)
            .join(', ') || '(none)'
        }`
      )
    }

    return this
  }

  /**
   * That it was delayed, which `assertPushed` cannot see.
   *
   * A job meant to run in an hour and pushed with no delay runs immediately, and
   * every other assertion about it still passes.
   */
  assertPushedWithDelay(job: string, seconds?: number): this {
    const delayed = this.pushed(job).filter((one) =>
      seconds === undefined ? one.delay > 0 : one.delay === seconds
    )

    if (delayed.length === 0) {
      throw new Error(
        `Expected [${job}] to be pushed with a delay${seconds === undefined ? '' : ` of ${seconds}s`}. Saw delays: ${
          this.pushed(job)
            .map((one) => one.delay)
            .join(', ') || '(none)'
        }`
      )
    }

    return this
  }

  assertNothingPushed(): this {
    if (this.driver.pushed.length > 0) {
      throw new Error(`Expected nothing to have been pushed, but found: ${this.summary()}`)
    }

    return this
  }

  assertCount(count: number): this {
    if (this.driver.pushed.length !== count) {
      throw new Error(
        `Expected ${count} job(s) to have been pushed, but found ${this.driver.pushed.length}.`
      )
    }

    return this
  }

  /** Forget everything recorded, without un-faking. */
  flush(): this {
    this.driver.pushed.length = 0

    return this
  }

  private summary(): string {
    return (
      this.driver.pushed.map((one) => `${one.payload.job} on ${one.queue}`).join(', ') ||
      '(nothing)'
    )
  }
}
