/**
 * The epoch that makes a cached session cookie revocable.
 *
 * `session.cookieCache` puts the session in a cookie so most requests need no
 * store lookup — worth half again as much throughput on the cookie path. The hole
 * it opens is that **nothing reads the store any more**, so a session that has
 * been signed out, deleted or banned keeps working until the cached copy expires.
 * At the `maxAge: 300` better-auth documents, that is five minutes in which "log
 * out everywhere" has not happened.
 *
 * better-auth leaves a seam for exactly this: `session.cookieCache.version` may
 * be a function, and a cached cookie whose version no longer matches is thrown
 * away and the store read instead. So the framework keeps one number per user —
 * bumped whenever any of their sessions is revoked — and hands it back as the
 * version. A revoked session mismatches on its very next request.
 *
 * The cost is one cache read per request, and it buys back correctness for a
 * tenth of the win. Measured on the `api` kit against Postgres 17, production
 * mode, 50 concurrent sessions, best of three rounds after a discarded warm-up:
 *
 * | `/api/auth/get-session` | req/s | p50 |
 * | --- | --- | --- |
 * | no cookie cache | 6,664 | 7.18 ms |
 * | cached, revocation delayed 300 s | 10,241 | 4.41 ms |
 * | cached, this, `CACHE_STORE=redis` | 9,252 | 4.98 ms |
 * | cached, this, `CACHE_STORE=file` | 8,853 | 5.12 ms |
 */

/** What this needs from `@elvel/cache`, which is not a dependency of this package. */
export type CacheLike = {
  store(name?: string): {
    get<T = unknown>(key: string): Promise<T | null>
    put(key: string, value: unknown, ttl?: number): Promise<boolean>
  }
}

export class SessionRevocations {
  /**
   * @param cache Resolved lazily: the cache manager is registered by a provider
   *   that may boot after this one, and an application may have none at all.
   * @param ttl How long an epoch is kept, in seconds. Anything shorter than the
   *   cookie it invalidates would let a stale cookie match again once the epoch
   *   expired, so callers pass the cookie's `maxAge` plus a margin.
   */
  constructor(
    private readonly cache: () => CacheLike | undefined,
    private readonly ttl: number
  ) {}

  private key(userId: string): string {
    return `auth:revocation:${userId}`
  }

  /**
   * The user's current epoch, as the version of a cached session.
   *
   * **Fails closed.** With no cache to read — none registered, or a store that
   * threw — this answers a value that cannot match any cookie, which costs the
   * optimisation and keeps the guarantee. The alternative is answering the
   * default and trusting a cookie whose session may be gone.
   */
  async epoch(userId: string): Promise<string> {
    const cache = this.cache()

    if (cache === undefined) return SessionRevocations.unmatchable()

    try {
      // '1' is better-auth's own default for a cookie carrying no version, so a
      // user who has never had a session revoked matches without a write.
      return (await cache.store().get<string>(this.key(userId))) ?? '1'
    } catch {
      return SessionRevocations.unmatchable()
    }
  }

  /**
   * Invalidate every cached session cookie this user holds, from now.
   *
   * Called from better-auth's own database hooks rather than from its endpoints,
   * so it covers the paths an application reaches without an HTTP request too —
   * a console command deleting sessions, a worker banning an account.
   *
   * A failure here is swallowed: it runs after the revocation itself has already
   * been written to the store, and throwing would turn a completed sign-out into
   * a 500 for the person signing out. What is lost is promptness, not the
   * revocation, and the cookie still expires on its own.
   */
  async revoke(userId: string): Promise<void> {
    const cache = this.cache()

    if (cache === undefined) return

    try {
      await cache.store().put(this.key(userId), String(Date.now()), this.ttl)
    } catch {
      // Deliberately quiet. See above.
    }
  }

  /**
   * A version no cookie can be carrying.
   *
   * Random rather than a constant, because the same function fills in the
   * version when the cookie is *written*: a constant would be written and then
   * matched, which is precisely the trust this is refusing to extend.
   */
  private static unmatchable(): string {
    return `unavailable:${crypto.randomUUID()}`
  }
}
