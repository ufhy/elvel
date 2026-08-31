import type { Repository } from './repository.ts'

/**
 * Counts attempts in a window — `Illuminate\Cache\RateLimiter`.
 *
 * Two keys per limit: the counter, and a `:timer` holding the moment the window
 * closes. The timer is what makes `availableIn()` answerable, and what tells a
 * counter that outlived its window apart from one that is genuinely exhausted —
 * the counter alone cannot, because a store may keep an expired value briefly.
 */
export class RateLimiter {
  constructor(private readonly cache: Repository) {}

  /**
   * Run `callback` unless the key is exhausted.
   *
   * Returns `false` when the limit is hit, so a caller can tell "denied" from a
   * callback that legitimately returned nothing.
   */
  async attempt<T>(
    key: string,
    maxAttempts: number,
    callback: () => T | Promise<T>,
    decaySeconds = 60
  ): Promise<T | false> {
    if (await this.tooManyAttempts(key, maxAttempts)) return false

    const result = await callback()
    await this.hit(key, decaySeconds)

    return result === undefined ? (true as unknown as T) : result
  }

  async tooManyAttempts(key: string, maxAttempts: number): Promise<boolean> {
    if ((await this.attempts(key)) >= maxAttempts) {
      if (await this.cache.has(`${this.clean(key)}:timer`)) return true

      // The window closed but the counter is still around: start over.
      await this.resetAttempts(key)
    }

    return false
  }

  /** Record one attempt. */
  async hit(key: string, decaySeconds = 60): Promise<number> {
    return this.increment(key, decaySeconds)
  }

  /**
   * Record `amount` attempts and answer the running total.
   *
   * Three round trips became one where the store can do it: add the timer, add the
   * counter to give it a window, increment it, and put it back if the window had
   * already gone. Against Redis that was 139µs of a throttled request's budget.
   *
   * The `:timer` key is only written when the increment created the counter — the
   * two are made and expire together, so a counter that already exists has a timer
   * that already exists. It is what `availableIn` reads to tell a client when to
   * come back, and it cannot be replaced by the counter's own TTL because the
   * `Store` interface does not expose one.
   *
   * A store without `incrementWithin` keeps the old sequence, because `increment`
   * on a missing key creates a counter with no window and a rate limit that never
   * resets is not a rate limit.
   */
  async increment(key: string, decaySeconds = 60, amount = 1): Promise<number> {
    const clean = this.clean(key)
    const atomic = this.cache.incrementWithin(clean, decaySeconds, amount)

    if (atomic === undefined) {
      await this.cache.add(`${clean}:timer`, this.availableAt(decaySeconds), decaySeconds)

      const added = await this.cache.add(clean, 0, decaySeconds)
      const hits = Number(await this.cache.increment(clean, amount))

      if (!added && hits === amount) await this.cache.put(clean, amount, decaySeconds)

      return hits
    }

    const hits = await atomic

    // The first hit of a window is the one that opens it.
    if (hits === amount) {
      await this.cache.put(`${clean}:timer`, this.availableAt(decaySeconds), decaySeconds)
    }

    return hits
  }

  async decrement(key: string, decaySeconds = 60, amount = 1): Promise<number> {
    return this.increment(key, decaySeconds, -amount)
  }

  async attempts(key: string): Promise<number> {
    return Number((await this.cache.get<number>(this.clean(key))) ?? 0)
  }

  async resetAttempts(key: string): Promise<boolean> {
    return this.cache.forget(this.clean(key))
  }

  /** Attempts left before the limit is reached. */
  async remaining(key: string, maxAttempts: number): Promise<number> {
    return Math.max(0, maxAttempts - (await this.attempts(key)))
  }

  async retriesLeft(key: string, maxAttempts: number): Promise<number> {
    return this.remaining(key, maxAttempts)
  }

  /** Forget the counter and the window. */
  async clear(key: string): Promise<void> {
    const clean = this.clean(key)

    await this.resetAttempts(key)
    await this.cache.forget(`${clean}:timer`)
  }

  /** Seconds until the window closes — what a `Retry-After` header wants. */
  async availableIn(key: string): Promise<number> {
    const until = await this.cache.get<number>(`${this.clean(key)}:timer`)
    if (until === null) return 0

    return Math.max(0, Number(until) - Math.floor(Date.now() / 1000))
  }

  private availableAt(seconds: number): number {
    return Math.floor(Date.now() / 1000) + seconds
  }

  /**
   * Keys often come from user input (an e-mail, a route name plus an IP), so the
   * separators a store cares about are normalised away.
   */
  private clean(key: string): string {
    return key.replaceAll('|', ':').replaceAll('&', ':')
  }
}
