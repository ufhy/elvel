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
 * A queue driver that records instead of queueing.
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

  /**
   * The chain a job carries, by class name and in order.
   *
   * "This controller dispatches these three jobs *in order*" was untestable —
   * and ordering is the only reason to use a chain rather than three dispatches.
   */
  chained(job?: string): string[][] {
    return this.pushed(job)
      .filter((one) => (one.payload.chain?.length ?? 0) > 0)
      .map((one) => [one.payload.job, ...(one.payload.chain ?? []).map((link) => link.job)])
  }

  /** `assertChained('Extract', ['Transform', 'Load'])` — the links after the head. */
  assertChained(job: string, links: string[]): this {
    const found = this.chained(job)
    const wanted = [job, ...links]

    if (
      !found.some(
        (chain) => chain.length === wanted.length && chain.every((name, at) => name === wanted[at])
      )
    ) {
      throw new Error(
        `Expected [${job}] to be chained with [${links.join(' -> ')}]. Saw: ${
          found.map((chain) => chain.join(' -> ')).join('; ') || '(no chains)'
        }`
      )
    }

    return this
  }

  /** Pushed, and on its own — a chain somebody added by mistake fails this. */
  assertDispatchedWithoutChain(job: string): this {
    this.assertPushed(job)

    const chained = this.chained(job)

    if (chained.length > 0) {
      throw new Error(
        `Expected [${job}] to be pushed without a chain, but it carried [${chained[0]?.slice(1).join(' -> ')}].`
      )
    }

    return this
  }

  assertNothingChained(): this {
    const chains = this.chained()

    if (chains.length > 0) {
      throw new Error(
        `Expected nothing to be chained, but found: ${chains.map((chain) => chain.join(' -> ')).join('; ')}`
      )
    }

    return this
  }

  /** Everything pushed as part of a batch, by batch id. */
  batched(): Map<string, PushedJob[]> {
    const batches = new Map<string, PushedJob[]>()

    for (const one of this.driver.pushed) {
      const id = one.payload.batchId

      if (id === undefined) continue

      batches.set(id, [...(batches.get(id) ?? []), one])
    }

    return batches
  }

  /** `assertBatched(['ImportRow', 'ImportRow'])` — one batch holding these jobs. */
  assertBatched(jobs: string[]): this {
    const wanted = [...jobs].sort()

    const found = [...this.batched().values()].some((batch) => {
      const names = batch.map((one) => one.payload.job).sort()

      return names.length === wanted.length && names.every((name, at) => name === wanted[at])
    })

    if (!found) {
      throw new Error(
        `Expected a batch of [${jobs.join(', ')}]. Saw: ${
          [...this.batched().values()]
            .map((batch) => batch.map((one) => one.payload.job).join(', '))
            .join('; ') || '(no batches)'
        }`
      )
    }

    return this
  }

  assertBatchCount(count: number): this {
    const actual = this.batched().size

    if (actual !== count) {
      throw new Error(`Expected ${count} batch(es), but ${actual} were dispatched.`)
    }

    return this
  }

  assertNothingBatched(): this {
    return this.assertBatchCount(0)
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
