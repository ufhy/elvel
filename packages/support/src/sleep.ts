/**
 * A sleep that can be faked, so code with a backoff in it is testable.
 *
 * `Bun.sleep` is not replaceable, so anything built on it — a lock that polls, a
 * retry, a rate limiter's wait — can only be tested by actually waiting. This is
 * the seam: `Sleep.fake()` records instead of waiting, and the assertions say
 * what was asked for.
 */

import { Clock } from './clock.ts'

type Recorded = { milliseconds: number }

let faking = false
let recorded: Recorded[] = []

/** Swap the clock. Only `Sleep` reads it, and only a test replaces it. */
let sleeper: (milliseconds: number) => Promise<void> = (ms) => Bun.sleep(ms)

/** A pending sleep, so the duration can be read before it is awaited. */
export class PendingSleep implements PromiseLike<void> {
  constructor(readonly milliseconds: number) {}

  /** Add to it: `Sleep.seconds(1).and.milliseconds(500)`. */
  get and(): SleepBuilder {
    return builderFrom(this.milliseconds)
  }

  /**
   * Thenable on purpose, and the opposite of the rule `Pipeline` and `Funnel`
   * follow: those must never be awaited, this exists to be. `await Sleep.seconds(1)`
   * is the whole API, and the duration is readable before the await so a test can
   * assert on it.
   */
  // biome-ignore lint/suspicious/noThenProperty: awaiting it is the API; see above.
  then<T = void, E = never>(
    // biome-ignore lint/suspicious/noConfusingVoidType: `PromiseLike<void>` types it this way, and this implements that.
    onFulfilled?: ((value: void) => T | PromiseLike<T>) | null,
    onRejected?: ((reason: unknown) => E | PromiseLike<E>) | null
  ): PromiseLike<T | E> {
    return this.run().then(onFulfilled, onRejected)
  }

  private async run(): Promise<void> {
    if (this.milliseconds <= 0) return

    if (faking) {
      recorded.push({ milliseconds: this.milliseconds })

      /**
       * The clock moves with it. Without this a faked sleep inside a loop whose
       * deadline is wall-clock does not wait and does not finish either — it
       * spins until real time catches up, which is slower than the sleep it
       * replaced.
       */
      Clock.advance(this.milliseconds)

      return
    }

    await sleeper(this.milliseconds)
  }
}

type SleepBuilder = {
  microseconds(count: number): PendingSleep
  milliseconds(count: number): PendingSleep
  seconds(count: number): PendingSleep
  minutes(count: number): PendingSleep
  hours(count: number): PendingSleep
}

function builderFrom(base: number): SleepBuilder {
  return {
    microseconds: (count) => new PendingSleep(base + count / 1000),
    milliseconds: (count) => new PendingSleep(base + count),
    seconds: (count) => new PendingSleep(base + count * 1000),
    minutes: (count) => new PendingSleep(base + count * 60_000),
    hours: (count) => new PendingSleep(base + count * 3_600_000)
  }
}

export class SleepAssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SleepAssertionError'
  }
}

export const Sleep = {
  ...builderFrom(0),

  /** Sleep until a moment, or not at all if it has passed. */
  until(when: Date | number): PendingSleep {
    const at = when instanceof Date ? when.getTime() : when

    return new PendingSleep(Math.max(0, at - Clock.now()))
  },

  /** Record sleeps instead of taking them. */
  fake(): void {
    faking = true
    recorded = []
  },

  /** Take real sleeps again, and forget what was recorded. */
  restore(): void {
    faking = false
    recorded = []
  },

  /** What was slept for, in order, in milliseconds. */
  slept(): number[] {
    return recorded.map((entry) => entry.milliseconds)
  },

  assertSlept(milliseconds: number, times?: number): void {
    const matches = recorded.filter((entry) => entry.milliseconds === milliseconds).length

    if (times === undefined) {
      if (matches > 0) return

      throw new SleepAssertionError(
        `Expected a sleep of ${milliseconds}ms. Slept: [${Sleep.slept().join(', ')}].`
      )
    }

    if (matches === times) return

    throw new SleepAssertionError(
      `Expected ${times} sleep(s) of ${milliseconds}ms, and there were ${matches}. ` +
        `Slept: [${Sleep.slept().join(', ')}].`
    )
  },

  /** The whole sequence, in order — what a backoff is actually worth asserting. */
  assertSequence(milliseconds: number[]): void {
    const actual: number[] = Sleep.slept()
    const same =
      actual.length === milliseconds.length &&
      actual.every((value, index) => value === milliseconds[index])

    if (same) return

    throw new SleepAssertionError(
      `Expected the sleeps [${milliseconds.join(', ')}], and got [${actual.join(', ')}].`
    )
  },

  assertNeverSlept(): void {
    if (recorded.length === 0) return

    throw new SleepAssertionError(`Expected no sleeping, and got [${Sleep.slept().join(', ')}].`)
  },

  /** How long was slept in total, in milliseconds. */
  total(): number {
    return recorded.reduce((sum, entry) => sum + entry.milliseconds, 0)
  },

  /** Replace the underlying wait. For a runtime without `Bun.sleep`. */
  sleepUsing(callback: (milliseconds: number) => Promise<void>): void {
    sleeper = callback
  }
}
