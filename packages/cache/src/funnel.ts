import { type Lock, LockTimeoutError } from './store.ts'

/** How a funnel gets the locks it hands out. Satisfied by `Repository`. */
export type LockFactory = (name: string, seconds: number) => Lock

/**
 * A semaphore over the cache — Laravel's `Redis::funnel()`.
 *
 * `withoutOverlapping()` is one at a time. This is *N* at a time, which is the
 * shape of nearly every real constraint: an API that allows three concurrent
 * calls, a report generator that would exhaust memory at four, a legacy database
 * with a small connection pool. Without it those become one-at-a-time and the
 * work takes as long as the sum of its parts.
 *
 * Laravel's version is Redis-only, because it acquires a slot with a Lua script.
 * This one is not: a `Lock` is already atomic on every driver here, so N named
 * locks are a semaphore that works the same on `array`, `file`, `database` and
 * `redis`. The cost is N round trips in the worst case rather than one, which
 * matters far less than a limiter that only exists on one driver.
 *
 * ```ts
 * await cache().funnel('reports').limit(3).releaseAfter(60).block(10, async () => {
 *   await generateReport()
 * })
 * ```
 */
export class Funnel {
  private slots = 1
  private lockFor = 60
  private sleepMilliseconds = 250

  constructor(
    private readonly name: string,
    private readonly lock: LockFactory
  ) {}

  /** How many callers may hold a slot at once. */
  limit(slots: number): this {
    this.slots = Math.max(1, Math.floor(slots))

    return this
  }

  /**
   * How long a slot survives without being released, in seconds.
   *
   * This is the crash guard, not the expected duration: a process killed while
   * holding a slot never releases it, and without an expiry that slot is gone
   * until somebody notices. Set it above the longest run you expect — expiring
   * early lets a second caller in while the first is still working, which is the
   * one failure a semaphore exists to prevent.
   */
  releaseAfter(seconds: number): this {
    this.lockFor = seconds

    return this
  }

  /** Milliseconds between attempts while waiting for a slot. */
  betweenBlockedAttemptsSleepFor(milliseconds: number): this {
    this.sleepMilliseconds = milliseconds

    return this
  }

  /**
   * Take a slot if one is free, run the callback, and give it back.
   *
   * Returns `false` when every slot is taken — distinguishable from a callback
   * that returned nothing, because the callback's result is only ever returned
   * when it actually ran.
   */
  async then<T>(callback: () => T | Promise<T>): Promise<T | false> {
    const slot = await this.acquire()
    if (!slot) return false

    return this.run(slot, callback)
  }

  /**
   * Wait up to `seconds` for a slot, then throw `LockTimeoutError`.
   *
   * Measured against the clock rather than counted in attempts, so a slow driver
   * cannot quietly stretch the timeout — the same rule `Lock.block()` follows.
   */
  async block<T>(seconds: number, callback?: () => T | Promise<T>): Promise<T | boolean> {
    const deadline = Date.now() + seconds * 1000

    let slot = await this.acquire()

    while (!slot) {
      if (Date.now() + this.sleepMilliseconds > deadline) {
        throw new LockTimeoutError(this.name)
      }

      await Bun.sleep(this.sleepMilliseconds)
      slot = await this.acquire()
    }

    if (!callback) {
      // No callback means "did I get in?", and the slot is released at once —
      // holding it would be a leak with nothing to release it.
      await slot.release()

      return true
    }

    return this.run(slot, callback)
  }

  /** How many slots are free right now. For a health endpoint, not for deciding. */
  async free(): Promise<number> {
    let free = 0

    for (let index = 1; index <= this.slots; index += 1) {
      const lock = this.lock(this.slotName(index), this.lockFor)

      if (await lock.isOwnedBy(null)) free += 1
    }

    return free
  }

  /**
   * The first free slot, or undefined.
   *
   * Tried in order rather than at random: with slots taken and released
   * constantly, going in order keeps the later slots cold, and a limiter whose
   * last slot is rarely used is one whose ceiling you can see in a dashboard.
   */
  private async acquire(): Promise<Lock | undefined> {
    for (let index = 1; index <= this.slots; index += 1) {
      const lock = this.lock(this.slotName(index), this.lockFor)

      if (await lock.acquire()) return lock
    }

    return undefined
  }

  private async run<T>(slot: Lock, callback: () => T | Promise<T>): Promise<T> {
    try {
      return await callback()
    } finally {
      // Released even when the callback throws: a slot held by a failure is one
      // the next caller waits `releaseAfter` seconds for, and the whole funnel
      // narrows by one every time something goes wrong.
      await slot.release()
    }
  }

  private slotName(index: number): string {
    return `${this.name}:slot:${index}`
  }
}
