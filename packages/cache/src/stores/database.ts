import type { Connection, ConnectionManager } from '@elyvel/database'
import { QueryBuilder } from '@elyvel/database'
import { decode, encode, expiresAt } from '../payload.ts'
import { Lock, type LockProvider, type Store } from '../store.ts'

export type DatabaseStoreOptions = {
  connection?: string
  table?: string
  lockTable?: string
  prefix?: string
  lockConnection?: string
}

/**
 * A store on our own connection — `Illuminate\Cache\DatabaseStore`.
 *
 * Worth having even next to Redis: it needs no extra service, it survives a
 * restart, and it shares the application's transaction and event stream. The
 * cost is a row per entry and no expiry sweep of its own, which `cache:prune`
 * exists for.
 */
export class DatabaseStore implements Store, LockProvider {
  readonly prefix: string

  private readonly table: string
  private readonly lockTable: string

  constructor(
    private readonly db: ConnectionManager,
    private readonly options: DatabaseStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? ''
    this.table = options.table ?? 'cache'
    this.lockTable = options.lockTable ?? 'cache_locks'
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return (await this.many<T>([key]))[key] ?? null
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    const result: Record<string, T | null> = {}
    for (const key of keys) result[key] = null

    if (keys.length === 0) return result

    const rows = await (await this.query())
      .whereIn(
        'key',
        keys.map((key) => this.prefix + key)
      )
      .get()

    const now = Math.floor(Date.now() / 1000)
    const expired: string[] = []

    for (const row of rows.all()) {
      const key = String(row.key).slice(this.prefix.length)

      if (Number(row.expiration) <= now) {
        expired.push(String(row.key))
        continue
      }

      result[key] = decode<T>(String(row.value))
    }

    // Reading is the only sweep this store gets for free.
    if (expired.length > 0) await (await this.query()).whereIn('key', expired).delete()

    return result
  }

  async put(key: string, value: unknown, seconds: number): Promise<boolean> {
    return this.putMany({ [key]: value }, seconds)
  }

  async putMany(values: Record<string, unknown>, seconds: number): Promise<boolean> {
    const expiration = expiresAt(seconds)

    const rows = Object.entries(values).map(([key, value]) => ({
      key: this.prefix + key,
      value: encode(value),
      expiration
    }))

    // An upsert, not an insert: a cache write always wins over what is there.
    return (await (await this.query()).upsert(rows, ['key'], ['value', 'expiration'])) > 0
  }

  /**
   * Insert only when absent, letting the primary key decide.
   *
   * `insertOrIgnore` is the atomic part; the expired-row case has to be cleared
   * first, or a dead entry would block the write forever.
   */
  async add(key: string, value: unknown, seconds: number): Promise<boolean> {
    const prefixed = this.prefix + key
    const now = Math.floor(Date.now() / 1000)

    await (await this.query()).where('key', '=', prefixed).where('expiration', '<=', now).delete()

    const inserted = await (await this.query()).insertOrIgnore({
      key: prefixed,
      value: encode(value),
      expiration: expiresAt(seconds)
    })

    return inserted > 0
  }

  /**
   * Read, add, write — inside a transaction with the row locked.
   *
   * Two requests incrementing the same counter without `for update` would both
   * read the old value and one increment would vanish.
   */
  async increment(key: string, value = 1): Promise<number | false> {
    const connection = await this.db.connection(this.options.connection)

    return connection.transaction(async (tx) => {
      const row = await this.on(tx, this.table)
        .where('key', '=', this.prefix + key)
        .lockForUpdate()
        .first()

      if (!row) {
        // No row yet: create the counter, as the other stores do — inside the
        // same transaction, so a concurrent increment waits for it.
        await this.on(tx, this.table).insertOrIgnore({
          key: this.prefix + key,
          value: encode(value),
          expiration: expiresAt(0)
        })

        return value
      }

      const current = decode(String(row.value))
      if (typeof current !== 'number') return false

      const next = current + value

      await this.on(tx, this.table)
        .where('key', '=', this.prefix + key)
        .update({ value: encode(next) })

      return next
    })
  }

  async decrement(key: string, value = 1): Promise<number | false> {
    return this.increment(key, -value)
  }

  async forever(key: string, value: unknown): Promise<boolean> {
    return this.put(key, value, 0)
  }

  async forget(key: string): Promise<boolean> {
    return (await (await this.query()).where('key', '=', this.prefix + key).delete()) > 0
  }

  async flush(): Promise<boolean> {
    await (await this.query()).delete()

    return true
  }

  /** Delete every expired entry — what `cache:prune` calls. */
  async prune(): Promise<number> {
    const now = Math.floor(Date.now() / 1000)

    const entries = await (await this.query()).where('expiration', '<=', now).delete()
    const locks = await (await this.lockQuery()).where('expiration', '<=', now).delete()

    return entries + locks
  }

  lock(name: string, seconds = 0, owner?: string): Lock {
    return new DatabaseLock(() => this.lockQuery(), this.prefix + name, seconds, owner)
  }

  restoreLock(name: string, owner: string): Lock {
    return this.lock(name, 0, owner)
  }

  private async query(): Promise<QueryBuilder> {
    return this.db.table(this.table, this.options.connection)
  }

  private async lockQuery(): Promise<QueryBuilder> {
    return this.db.table(this.lockTable, this.options.lockConnection ?? this.options.connection)
  }

  /** A builder bound to a transaction's connection rather than the pool's. */
  private on(connection: Connection, table: string): QueryBuilder {
    return new QueryBuilder(connection, table)
  }
}

class DatabaseLock extends Lock {
  constructor(
    private readonly query: () => Promise<QueryBuilder>,
    name: string,
    seconds: number,
    owner?: string
  ) {
    super(name, seconds, owner)
  }

  async acquire(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000)

    // Clear a lock whose holder is gone, then let the primary key arbitrate.
    await (await this.query()).where('key', '=', this.name).where('expiration', '<=', now).delete()

    const inserted = await (await this.query()).insertOrIgnore({
      key: this.name,
      owner: this.owner(),
      expiration: this.expiry()
    })

    return inserted > 0
  }

  async release(): Promise<boolean> {
    // The owner check is part of the delete, so a stale holder cannot release a
    // lock that has since been taken by someone else.
    const deleted = await (await this.query())
      .where('key', '=', this.name)
      .where('owner', '=', this.owner())
      .delete()

    return deleted > 0
  }

  override async refresh(seconds?: number): Promise<boolean> {
    const updated = await (await this.query())
      .where('key', '=', this.name)
      .where('owner', '=', this.owner())
      .update({ expiration: this.expiry(seconds) })

    return updated > 0
  }

  protected async currentOwner(): Promise<string | null> {
    const row = await (await this.query()).where('key', '=', this.name).first()

    if (!row) return null
    if (Number(row.expiration) <= Math.floor(Date.now() / 1000)) return null

    return String(row.owner)
  }

  private expiry(seconds = this.seconds): number {
    return expiresAt(seconds)
  }
}
