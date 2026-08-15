import { defer } from '@elysian/core'
import { Funnel } from './funnel.ts'
import { isLockProvider, type Lock, LockTimeoutError, type Store } from './store.ts'
import { NamespacedStore, TagSet } from './tags.ts'

/** Seconds, an absolute moment, or null for "keep it forever". */
export type Ttl = number | Date | null

/** Where cache events go. The events package satisfies this structurally. */
export type Dispatcher = { dispatch(event: string, payload?: unknown): unknown }

export type RepositoryOptions = {
  events?: Dispatcher
  /** Name reported in events, so a listener can tell the stores apart. */
  name?: string
}

/**
 * The cache API — `Illuminate\Cache\Repository`.
 *
 * A driver knows how to hold bytes for a number of seconds. Everything that makes
 * a cache pleasant to use lives here: `remember`, typed reads, stale-while-
 * revalidate, tags and locks, all expressed once rather than per driver.
 */
export class Repository {
  private defaultSeconds = 3600

  constructor(
    readonly store: Store,
    private readonly options: RepositoryOptions = {}
  ) {}

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }

  async missing(key: string): Promise<boolean> {
    return !(await this.has(key))
  }

  async get<T = unknown>(key: string, fallback?: T | (() => T | Promise<T>)): Promise<T | null> {
    const value = await this.store.get<T>(key)

    if (value === null || value === undefined) {
      this.event('cache.missed', { key })

      return fallback === undefined ? null : await Repository.resolve(fallback)
    }

    this.event('cache.hit', { key, value })

    return value
  }

  /** One round trip for several keys, where the driver supports it. */
  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    const values = await this.store.many<T>(keys)

    for (const key of keys) {
      if (values[key] === null || values[key] === undefined) this.event('cache.missed', { key })
      else this.event('cache.hit', { key, value: values[key] })
    }

    return values
  }

  /** Read and forget in one call. */
  async pull<T = unknown>(key: string, fallback?: T): Promise<T | null> {
    const value = await this.get<T>(key)
    await this.forget(key)

    return value ?? (fallback === undefined ? null : fallback)
  }

  async put(key: string, value: unknown, ttl?: Ttl): Promise<boolean> {
    if (ttl === undefined || ttl === null) return this.forever(key, value)

    const seconds = Repository.secondsFrom(ttl)

    // A TTL already in the past is a delete, not a write that expires instantly.
    if (seconds <= 0) return this.forget(key)

    const stored = await this.store.put(key, value, seconds)
    if (stored) this.event('cache.written', { key, value, seconds })

    return stored
  }

  async putMany(values: Record<string, unknown>, ttl?: Ttl): Promise<boolean> {
    if (ttl === undefined || ttl === null) {
      let all = true
      for (const [key, value] of Object.entries(values)) {
        all = (await this.forever(key, value)) && all
      }
      return all
    }

    const seconds = Repository.secondsFrom(ttl)
    if (seconds <= 0) {
      for (const key of Object.keys(values)) await this.forget(key)
      return false
    }

    const stored = await this.store.putMany(values, seconds)

    if (stored) {
      for (const [key, value] of Object.entries(values)) {
        this.event('cache.written', { key, value, seconds })
      }
    }

    return stored
  }

  /** Write only if the key is absent. Atomic where the driver can be. */
  async add(key: string, value: unknown, ttl?: Ttl): Promise<boolean> {
    const seconds = ttl === undefined || ttl === null ? 0 : Repository.secondsFrom(ttl)

    if (ttl !== undefined && ttl !== null && seconds <= 0) return false

    const added = await this.store.add(key, value, seconds)
    if (added) this.event('cache.written', { key, value, seconds })

    return added
  }

  async increment(key: string, value = 1): Promise<number | false> {
    return this.store.increment(key, value)
  }

  async decrement(key: string, value = 1): Promise<number | false> {
    return this.store.decrement(key, value)
  }

  async forever(key: string, value: unknown): Promise<boolean> {
    const stored = await this.store.forever(key, value)
    if (stored) this.event('cache.written', { key, value, seconds: 0 })

    return stored
  }

  /**
   * The one everybody uses: return what is cached, or compute it and cache it.
   *
   * ```ts
   * const stats = await cache().remember('stats', 300, () => expensive())
   * ```
   */
  async remember<T>(key: string, ttl: Ttl, callback: () => T | Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)
    if (cached !== null) return cached

    const value = await callback()
    await this.put(key, value, ttl)

    return value
  }

  async rememberForever<T>(key: string, callback: () => T | Promise<T>): Promise<T> {
    return this.remember(key, null, callback)
  }

  /** Laravel's alias for `rememberForever`. */
  async sear<T>(key: string, callback: () => T | Promise<T>): Promise<T> {
    return this.rememberForever(key, callback)
  }

  /**
   * Serve a stale value while refreshing it — Laravel's `flexible()`.
   *
   * Two TTLs: within the first the value is fresh; between the first and the
   * second it is served *and* refreshed behind a lock, so one slow request
   * refreshes it and the rest are not made to wait. Past the second it is gone
   * and the caller computes it.
   *
   * The refresh is deferred rather than awaited: the point is that the request
   * which noticed the staleness does not pay for it. `defer()` runs it after the
   * response has been sent; outside a request there is nothing to wait for, so it
   * runs at the next flush.
   */
  async flexible<T>(
    key: string,
    [fresh, total]: [Ttl, Ttl],
    callback: () => T | Promise<T>,
    lock: { seconds?: number; owner?: string } = {}
  ): Promise<T> {
    const createdKey = `elysian:cache:flexible:created:${key}`

    const { [key]: value, [createdKey]: created } = await this.many<T | number>([key, createdKey])

    const write = async (): Promise<T> => {
      const computed = await callback()

      await this.putMany({ [key]: computed, [createdKey]: Math.floor(Date.now() / 1000) }, total)

      return computed
    }

    if (value === null || created === null) return write()

    const freshUntil = Number(created) + Repository.secondsFrom(fresh)
    if (freshUntil > Math.floor(Date.now() / 1000)) return value as T

    const refresh = async () => {
      if (!isLockProvider(this.store)) {
        await write()
        return
      }

      await this.store
        .lock(`elysian:cache:flexible:lock:${key}`, lock.seconds ?? 0, lock.owner)
        .get(async () => {
          // Another request may have refreshed it while we waited for the lock;
          // the `created` stamp we read is the guard against doing it twice.
          const current = await this.store.get<number>(createdKey)
          if (Number(current) !== Number(created)) return

          await write()
        })
    }

    // Keyed so a burst of requests on the same stale key schedules one refresh,
    // not one per request. The rejection is swallowed by `flushDeferred`: a failed
    // background refresh must not surface as a failure of the request.
    defer(refresh, { key: `elysian:cache:flexible:${key}` })

    return value as T
  }

  async forget(key: string): Promise<boolean> {
    const forgotten = await this.store.forget(key)
    this.event('cache.forgotten', { key })

    return forgotten
  }

  /** Laravel's PSR-16 alias. */
  async delete(key: string): Promise<boolean> {
    return this.forget(key)
  }

  async flush(): Promise<boolean> {
    const flushed = await this.store.flush()
    this.event('cache.flushed', { store: this.options.name })

    return flushed
  }

  // --------------------------------------------------------------- typed reads

  /**
   * Typed getters, as Laravel added in 11.x.
   *
   * They are not casts: a value of the wrong type is a programming error and
   * throws, rather than being coerced into something that looks fine and is not.
   */
  async string(key: string, fallback?: string): Promise<string> {
    return this.typed(key, 'string', fallback)
  }

  async integer(key: string, fallback?: number): Promise<number> {
    const value = await this.typed<number>(key, 'number', fallback)

    return Math.trunc(value)
  }

  async float(key: string, fallback?: number): Promise<number> {
    return this.typed(key, 'number', fallback)
  }

  async boolean(key: string, fallback?: boolean): Promise<boolean> {
    return this.typed(key, 'boolean', fallback)
  }

  async array<T = unknown>(key: string, fallback?: T[]): Promise<T[]> {
    const value = await this.get<T[]>(key, fallback)

    if (!Array.isArray(value)) {
      throw new TypeError(`Cache value for [${key}] is not an array.`)
    }

    return value
  }

  // -------------------------------------------------------------------- locks

  /** An atomic lock from the driver. Throws on a driver that has none. */
  lock(name: string, seconds = 0, owner?: string): Lock {
    if (!isLockProvider(this.store)) {
      throw new Error('This cache store does not support atomic locks.')
    }

    return this.store.lock(name, seconds, owner)
  }

  restoreLock(name: string, owner: string): Lock {
    if (!isLockProvider(this.store)) {
      throw new Error('This cache store does not support atomic locks.')
    }

    return this.store.restoreLock(name, owner)
  }

  /**
   * Run `callback` while holding a lock, so two callers never overlap.
   *
   * Throws `LockTimeoutError` when the lock could not be had within `waitFor`.
   */
  async withoutOverlapping<T>(
    key: string,
    callback: () => T | Promise<T>,
    {
      lockFor = 0,
      waitFor = 10,
      owner
    }: { lockFor?: number; waitFor?: number; owner?: string } = {}
  ): Promise<T> {
    const result = await this.lock(key, lockFor, owner).block(waitFor, callback)

    return result as T
  }

  /**
   * A semaphore: at most N callers at a time — Laravel's `funnel()`.
   *
   * `withoutOverlapping()` is the N=1 case. Anything else — three concurrent
   * calls to an API, four report generators that would exhaust memory — needs
   * this, and doing it with one lock turns concurrent work into a queue.
   */
  funnel(name: string): Funnel {
    return new Funnel(name, (slot, seconds) => this.lock(slot, seconds))
  }

  // --------------------------------------------------------------------- tags

  /** A view of this store limited to a set of tags. */
  /**
   * Forget several keys at once — PSR-16's `deleteMultiple`.
   *
   * Answers false if any one of them failed, and still attempts the rest: a
   * partial flush that stops at the first miss leaves stale entries behind, which
   * is the failure this is usually called to prevent.
   */
  async deleteMultiple(keys: string[]): Promise<boolean> {
    let all = true

    for (const key of keys) {
      if (!(await this.forget(key))) all = false
    }

    return all
  }

  /** PSR-16 spellings of `many` and `putMany`, for a caller expecting them. */
  getMultiple<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    return this.many<T>(keys)
  }

  setMultiple(values: Record<string, unknown>, seconds?: number): Promise<boolean> {
    return this.putMany(values, seconds)
  }

  /**
   * Extend a key's life without touching its value.
   *
   * Read, then written back with a fresh TTL, because no store here exposes a
   * bare expiry update. That means it is not atomic: a write between the read and
   * the put is overwritten. Worth knowing before using it on anything contended,
   * and harmless for what it is usually for — keeping a session or a lock alive
   * while work continues.
   */
  async touch(key: string, seconds?: number): Promise<boolean> {
    const value = await this.get(key)
    if (value === null || value === undefined) return false

    return this.put(key, value, seconds)
  }

  /**
   * Does this store carry tags?
   *
   * `tags()` builds a `TaggedCache` whatever the store is, and the tag set needs
   * somewhere to keep its own bookkeeping — asking first is how a caller avoids
   * finding out through a flush that quietly clears nothing.
   */
  supportsTags(): boolean {
    return typeof (this.store as { tagsSupported?: boolean }).tagsSupported === 'boolean'
      ? ((this.store as { tagsSupported?: boolean }).tagsSupported as boolean)
      : true
  }

  tags(...names: Array<string | string[]>): TaggedCache {
    return new TaggedCache(this.store, new TagSet(this.store, names.flat()), this.options)
  }

  /** Default TTL for writes that do not name one, in seconds. */
  setDefaultCacheTime(seconds: number): this {
    this.defaultSeconds = seconds

    return this
  }

  getDefaultCacheTime(): number {
    return this.defaultSeconds
  }

  protected event(name: string, payload: Record<string, unknown>): void {
    this.options.events?.dispatch(name, { store: this.options.name, ...payload })
  }

  private async typed<T>(key: string, expected: string, fallback?: T): Promise<T> {
    const value: unknown = await this.get<T>(key, fallback)

    if (typeof value !== expected) {
      throw new TypeError(`Cache value for [${key}] is not a ${expected}.`)
    }

    return value as T
  }

  private static async resolve<T>(value: T | (() => T | Promise<T>)): Promise<T> {
    return typeof value === 'function' ? await (value as () => T | Promise<T>)() : value
  }

  /** Seconds from now, from either a count of seconds or a moment. */
  static secondsFrom(ttl: Ttl): number {
    if (ttl === null) return 0
    if (typeof ttl === 'number') return Math.trunc(ttl)

    return Math.ceil((ttl.getTime() - Date.now()) / 1000)
  }
}

export { LockTimeoutError }

/**
 * A cache scoped to tags — `Illuminate\Cache\TaggedCache`.
 *
 * Every key is rewritten to `sha1(namespace):key`, so the same logical key under
 * different tags is a different entry, and `flush()` invalidates only this set.
 *
 * Defined here rather than beside `TagSet`: it extends `Repository`, and a module
 * that imports `Repository` while `Repository` imports it back cannot initialise —
 * the subclass is evaluated before its own base class exists.
 */
export class TaggedCache extends Repository {
  constructor(
    store: Store,
    readonly tagSet: TagSet,
    options: RepositoryOptions = {}
  ) {
    // The parent writes through a store whose keys are namespaced for us.
    super(new NamespacedStore(store, tagSet), options)
  }

  /** Replace the tag ids rather than deleting entries. */
  override async flush(): Promise<boolean> {
    await this.tagSet.reset()
    this.event('cache.flushed', { tags: this.tagSet.names })

    return true
  }

  /**
   * The tag names this view is scoped to.
   *
   * Not `tags`: that is the method on the repository that *opens* a tagged view,
   * and shadowing it with a property would make `cache().tags('a').tags('b')`
   * a type error instead of narrowing further.
   */
  get tagNames(): string[] {
    return this.tagSet.names
  }
}
