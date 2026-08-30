import type { Lock, LockProvider, Store } from '../store.ts'

/**
 * A short-lived memory tier in front of another store.
 *
 * A `get()` against the file store costs about 26µs on this machine, and 96% of
 * that is the filesystem read itself — hashing is 2% and decoding the payload is
 * half a percent, so there is nothing to shave off. The only way to make a hot
 * key cheap is to not go to the store at all. Against a whole request's budget of
 * roughly 57µs, one uncached settings lookup was costing nearly half of it.
 *
 * **This trades freshness for that, and the trade is real.** A cache is shared:
 * another process — a second web worker, a queue worker, a `bun elvel` command —
 * can write a key this process is still serving from memory. Writes made *here*
 * drop the entry immediately, so a single-process application never sees a stale
 * value; a multi-process one sees at most `seconds` of staleness after somebody
 * else's write.
 *
 * That is why it is off unless asked for. `cache.memory` names the window in
 * seconds, and picking it is picking how stale a value may be:
 *
 * ```ts
 * // config/cache.ts
 * memory: 1
 * ```
 *
 * One second suits configuration, feature flags and permission maps — things read
 * on every request and changed by a deploy. Do not put it in front of a counter,
 * a rate limiter, or a lock: those are read-modify-write, and a stale read is a
 * wrong answer rather than an old one.
 */
export class MemoStore implements Store, LockProvider {
  private readonly memo = new Map<string, { value: unknown; until: number }>()

  constructor(
    private readonly inner: Store,
    private readonly seconds: number,
    /** Injectable clock, so the window is testable without waiting. */
    private readonly now: () => number = () => Date.now()
  ) {}

  get prefix(): string {
    return this.inner.prefix
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const held = this.memo.get(key)

    if (held !== undefined && held.until > this.now()) return held.value as T

    const value = await this.inner.get<T>(key)

    this.remember(key, value)

    return value
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    const answer: Record<string, T | null> = {}
    const missing: string[] = []

    for (const key of keys) {
      const held = this.memo.get(key)

      if (held !== undefined && held.until > this.now()) answer[key] = held.value as T
      else missing.push(key)
    }

    if (missing.length > 0) {
      const fetched = await this.inner.many<T>(missing)

      for (const [key, value] of Object.entries(fetched)) {
        this.remember(key, value)
        answer[key] = value
      }
    }

    return answer
  }

  async put(key: string, value: unknown, seconds: number): Promise<boolean> {
    this.memo.delete(key)

    return this.inner.put(key, value, seconds)
  }

  async putMany(values: Record<string, unknown>, seconds: number): Promise<boolean> {
    for (const key of Object.keys(values)) this.memo.delete(key)

    return this.inner.putMany(values, seconds)
  }

  async add(key: string, value: unknown, seconds: number): Promise<boolean> {
    this.memo.delete(key)

    return this.inner.add(key, value, seconds)
  }

  /**
   * Never served from memory, and never remembered.
   *
   * `increment` is read-modify-write against the store, which is the one shape a
   * stale value turns into a wrong answer rather than an old one.
   */
  async increment(key: string, value = 1): Promise<number | false> {
    this.memo.delete(key)

    return this.inner.increment(key, value)
  }

  async decrement(key: string, value = 1): Promise<number | false> {
    this.memo.delete(key)

    return this.inner.decrement(key, value)
  }

  async forever(key: string, value: unknown): Promise<boolean> {
    this.memo.delete(key)

    return this.inner.forever(key, value)
  }

  async forget(key: string): Promise<boolean> {
    this.memo.delete(key)

    return this.inner.forget(key)
  }

  async flush(): Promise<boolean> {
    this.memo.clear()

    return this.inner.flush()
  }

  /** Locks belong to the store they coordinate; nothing here caches them. */
  lock(name: string, seconds?: number, owner?: string): Lock {
    return this.lockProvider().lock(name, seconds, owner)
  }

  restoreLock(name: string, owner: string): Lock {
    return this.lockProvider().restoreLock(name, owner)
  }

  private lockProvider(): LockProvider {
    const provider = this.inner as Partial<LockProvider>

    if (typeof provider.lock !== 'function') {
      throw new Error(
        `The store behind this memory tier does not support locks. Locks coordinate across processes, so they are never served from memory.`
      )
    }

    return provider as LockProvider
  }

  private remember(key: string, value: unknown): void {
    this.memo.set(key, { value, until: this.now() + this.seconds * 1000 })

    // Bounded, so a scan of a million distinct keys cannot become a memory leak.
    // Oldest-inserted goes first, which for a TTL this short is close enough to
    // least-recently-used that the difference is not worth a second structure.
    if (this.memo.size > 1_000) {
      const oldest = this.memo.keys().next()

      if (!oldest.done) this.memo.delete(oldest.value)
    }
  }
}
