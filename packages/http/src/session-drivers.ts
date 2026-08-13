import type { SessionData, SessionDriver } from './session.ts'

/** The slice of a query builder these drivers need. */
type SessionQuery = {
  where(column: string, operator: string, value?: unknown): SessionQuery
  first(): Promise<Record<string, unknown> | undefined>
  insert(values: Record<string, unknown>): Promise<unknown>
  update(values: Record<string, unknown>): Promise<number>
  delete(): Promise<number>
}

type SessionTable = () => Promise<SessionQuery>

/**
 * Sessions in a table — `DatabaseSessionHandler`.
 *
 * The reason to want this is not scale, it is **more than one process**. A file
 * session lives on the machine that wrote it, so the moment an application runs
 * in two containers behind a load balancer, half the requests cannot find the
 * session and people are logged out at random — a failure that looks like a bug
 * in the auth code and is not.
 *
 * `last_activity` is a unix timestamp rather than a datetime, as Laravel's is:
 * expiry is arithmetic on an integer, which every dialect agrees about, and `gc`
 * is then one indexed comparison.
 */
export class DatabaseSessionDriver implements SessionDriver {
  constructor(private readonly table: SessionTable) {}

  async read(id: string): Promise<SessionData | undefined> {
    const row = await (await this.table()).where('id', '=', id).first()
    if (!row) return undefined

    try {
      // Base64 like Laravel's, so a payload with odd bytes cannot break the
      // column's encoding on its way through.
      return JSON.parse(Buffer.from(String(row.payload), 'base64').toString()) as SessionData
    } catch {
      // A truncated payload is a lost session, not a crash.
      return undefined
    }
  }

  async write(id: string, data: SessionData): Promise<void> {
    const payload = {
      payload: Buffer.from(JSON.stringify(data)).toString('base64'),
      last_activity: Math.floor(Date.now() / 1000)
    }

    const updated = await (await this.table()).where('id', '=', id).update(payload)
    if (updated > 0) return

    try {
      await (await this.table()).insert({ id, ...payload })
    } catch {
      /**
       * Two requests for the same new session can race to insert it, and the
       * loser hits the primary key. Updating instead is Laravel's recovery, and
       * it is right: the row exists now, which is all the caller wanted.
       */
      await (await this.table()).where('id', '=', id).update(payload)
    }
  }

  async destroy(id: string): Promise<void> {
    await (await this.table()).where('id', '=', id).delete()
  }

  async gc(lifetime: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - lifetime

    return (await this.table()).where('last_activity', '<=', cutoff).delete()
  }
}

/** The slice of a cache repository these drivers need. */
type SessionCache = {
  get<T>(key: string): Promise<T | null>
  put(key: string, value: unknown, seconds?: number): Promise<boolean>
  forget(key: string): Promise<boolean>
}

/**
 * Sessions in the cache — `CacheBasedSessionHandler`, which is what
 * `SESSION_DRIVER=redis` means.
 *
 * The store's own expiry does the collecting, so `gc()` has nothing to do and
 * says so by returning zero rather than pretending to have swept.
 */
export class CacheSessionDriver implements SessionDriver {
  constructor(
    private readonly cache: SessionCache,
    private readonly lifetime = 7200,
    private readonly prefix = 'session:'
  ) {}

  private key(id: string): string {
    return `${this.prefix}${id}`
  }

  async read(id: string): Promise<SessionData | undefined> {
    return (await this.cache.get<SessionData>(this.key(id))) ?? undefined
  }

  async write(id: string, data: SessionData): Promise<void> {
    // Written with the lifetime every time, which is what keeps an active session
    // alive: each request pushes the expiry out again.
    await this.cache.put(this.key(id), data, this.lifetime)
  }

  async destroy(id: string): Promise<void> {
    await this.cache.forget(this.key(id))
  }

  async gc(_lifetime: number): Promise<number> {
    return 0
  }
}
