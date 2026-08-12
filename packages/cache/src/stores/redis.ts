import { RedisClient } from 'bun'
import { decode, encode } from '../payload.ts'
import { Lock, type LockProvider, type Store } from '../store.ts'

export type RedisStoreOptions = {
  url?: string
  prefix?: string
  /** Passed through to Bun's client: timeouts, TLS, retries. */
  client?: ConstructorParameters<typeof RedisClient>[1]
}

/**
 * A Redis store on Bun's native client — `Illuminate\Cache\RedisStore`.
 *
 * Bun's client speaks RESP3, pipelines automatically and reconnects on its own,
 * so there is no client library to wrap. What is left is expressing the cache
 * contract in Redis terms, and the two places that matter are `add` and the
 * locks: both are one `SET … NX` rather than a read followed by a write, because
 * anything else races across processes.
 */
export class RedisStore implements Store, LockProvider {
  readonly prefix: string

  private readonly client: RedisClient

  constructor(options: RedisStoreOptions = {}) {
    this.prefix = options.prefix ?? ''
    this.client = new RedisClient(
      options.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      options.client
    )
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return decode<T>(await this.client.get(this.prefix + key))
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    const result: Record<string, T | null> = {}
    if (keys.length === 0) return result

    const values = await this.client.mget(...keys.map((key) => this.prefix + key))

    for (const [index, key] of keys.entries()) {
      result[key] = decode<T>(values[index] ?? null)
    }

    return result
  }

  async put(key: string, value: unknown, seconds: number): Promise<boolean> {
    const name = this.prefix + key

    if (seconds <= 0) return (await this.client.set(name, encode(value))) === 'OK'

    return (await this.client.set(name, encode(value), 'EX', seconds)) === 'OK'
  }

  async putMany(values: Record<string, unknown>, seconds: number): Promise<boolean> {
    // Sent together rather than in one MSET: MSET cannot carry an expiry, and
    // Bun pipelines these anyway, so it is still one round trip.
    const writes = Object.entries(values).map(([key, value]) => this.put(key, value, seconds))

    return (await Promise.all(writes)).every(Boolean)
  }

  /** `SET NX` — the write happens only if the key is absent, server-side. */
  async add(key: string, value: unknown, seconds: number): Promise<boolean> {
    const name = this.prefix + key
    const payload = encode(value)

    const result =
      seconds <= 0
        ? await this.client.set(name, payload, 'NX')
        : await this.client.set(name, payload, 'NX', 'EX', String(seconds))

    return result === 'OK'
  }

  /**
   * `INCRBY`, which needs the value stored as a bare number.
   *
   * A JSON-encoded number is its own digits, so `encode(1)` is `1` and Redis can
   * increment it in place. That is why `encode` is not wrapped in an envelope.
   */
  async increment(key: string, value = 1): Promise<number | false> {
    try {
      return await this.client.incrby(this.prefix + key, value)
    } catch {
      // The key holds something that is not a number.
      return false
    }
  }

  async decrement(key: string, value = 1): Promise<number | false> {
    return this.increment(key, -value)
  }

  async forever(key: string, value: unknown): Promise<boolean> {
    return this.put(key, value, 0)
  }

  async forget(key: string): Promise<boolean> {
    return (await this.client.del(this.prefix + key)) > 0
  }

  /**
   * Delete this store's own keys.
   *
   * `FLUSHDB` would take the whole database with it, including another
   * application's keys and anything else living on the same server. Scanning the
   * prefix is slower and correct. Without a prefix there is nothing to scan for,
   * so that case flushes the database and says so.
   */
  async flush(): Promise<boolean> {
    if (this.prefix === '') {
      await this.client.send('FLUSHDB', [])
      return true
    }

    let cursor = '0'

    do {
      const [next, keys] = (await this.client.send('SCAN', [
        cursor,
        'MATCH',
        `${this.prefix}*`,
        'COUNT',
        '500'
      ])) as [string, string[]]

      if (keys.length > 0) await this.client.send('DEL', keys)

      cursor = next
    } while (cursor !== '0')

    return true
  }

  lock(name: string, seconds = 0, owner?: string): Lock {
    return new RedisLock(this.client, this.prefix + name, seconds, owner)
  }

  restoreLock(name: string, owner: string): Lock {
    return this.lock(name, 0, owner)
  }

  /** Seconds left on a key, for tests and diagnostics. */
  async ttl(key: string): Promise<number> {
    return this.client.ttl(this.prefix + key)
  }

  /** Close the connection. The provider calls this on shutdown. */
  disconnect(): void {
    this.client.close()
  }
}

/**
 * Release has to compare the owner and delete in one step, which is what the
 * script is for: checking from the client and then deleting leaves a window in
 * which the lock expired and someone else took it, and we would delete theirs.
 */
const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const REFRESH = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
end
return 0
`

class RedisLock extends Lock {
  constructor(
    private readonly client: RedisClient,
    name: string,
    seconds: number,
    owner?: string
  ) {
    super(name, seconds, owner)
  }

  async acquire(): Promise<boolean> {
    if (this.seconds <= 0) {
      return (await this.client.set(this.name, this.owner(), 'NX')) === 'OK'
    }

    return (
      (await this.client.set(this.name, this.owner(), 'NX', 'EX', String(this.seconds))) === 'OK'
    )
  }

  async release(): Promise<boolean> {
    const released = await this.client.send('EVAL', [RELEASE, '1', this.name, this.owner()])

    return Number(released) > 0
  }

  override async refresh(seconds?: number): Promise<boolean> {
    const extend = seconds ?? this.seconds
    if (extend <= 0) return false

    const refreshed = await this.client.send('EVAL', [
      REFRESH,
      '1',
      this.name,
      this.owner(),
      String(extend)
    ])

    return Number(refreshed) > 0
  }

  protected async currentOwner(): Promise<string | null> {
    return this.client.get(this.name)
  }
}
