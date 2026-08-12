import { expiresAt, FOREVER } from '../payload.ts'
import { Lock, type LockProvider, type Store } from '../store.ts'

type Entry = { value: unknown; expires: number }

/**
 * An in-memory store — `Illuminate\Cache\ArrayStore`.
 *
 * Values are held as they were given, not serialised: it is the fastest driver
 * and the one tests use, and a round-trip that changed a `Date` into a string
 * would make it a poor stand-in for the others. The cost is that a cached object
 * is shared by reference, so mutating what you read mutates what is cached.
 */
export class ArrayStore implements Store, LockProvider {
  private readonly entries = new Map<string, Entry>()
  private readonly locks = new Map<string, { owner: string; expires: number }>()

  constructor(readonly prefix = '') {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.entries.get(this.prefix + key)
    if (!entry) return null

    if (this.hasExpired(entry)) {
      this.entries.delete(this.prefix + key)
      return null
    }

    return entry.value as T
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    const result: Record<string, T | null> = {}

    for (const key of keys) result[key] = await this.get<T>(key)

    return result
  }

  async put(key: string, value: unknown, seconds: number): Promise<boolean> {
    this.entries.set(this.prefix + key, { value, expires: expiresAt(seconds) })

    return true
  }

  async putMany(values: Record<string, unknown>, seconds: number): Promise<boolean> {
    for (const [key, value] of Object.entries(values)) await this.put(key, value, seconds)

    return true
  }

  async add(key: string, value: unknown, seconds: number): Promise<boolean> {
    // Single-threaded and synchronous, so a read followed by a write is atomic
    // here in a way it would not be against a shared server.
    if ((await this.get(key)) !== null) return false

    return this.put(key, value, seconds)
  }

  async increment(key: string, value = 1): Promise<number | false> {
    const entry = this.entries.get(this.prefix + key)

    if (!entry || this.hasExpired(entry)) {
      await this.put(key, value, 0)
      return value
    }

    if (typeof entry.value !== 'number') return false

    const next = entry.value + value
    // The expiry is kept: incrementing a counter must not extend its window.
    this.entries.set(this.prefix + key, { value: next, expires: entry.expires })

    return next
  }

  async decrement(key: string, value = 1): Promise<number | false> {
    return this.increment(key, -value)
  }

  async forever(key: string, value: unknown): Promise<boolean> {
    return this.put(key, value, 0)
  }

  async forget(key: string): Promise<boolean> {
    return this.entries.delete(this.prefix + key)
  }

  async flush(): Promise<boolean> {
    this.entries.clear()
    this.locks.clear()

    return true
  }

  lock(name: string, seconds = 0, owner?: string): Lock {
    return new ArrayLock(this.locks, this.prefix + name, seconds, owner)
  }

  restoreLock(name: string, owner: string): Lock {
    return this.lock(name, 0, owner)
  }

  private hasExpired(entry: Entry): boolean {
    return entry.expires !== FOREVER && entry.expires <= Math.floor(Date.now() / 1000)
  }
}

class ArrayLock extends Lock {
  constructor(
    private readonly locks: Map<string, { owner: string; expires: number }>,
    name: string,
    seconds: number,
    owner?: string
  ) {
    super(name, seconds, owner)
  }

  async acquire(): Promise<boolean> {
    const existing = this.locks.get(this.name)

    if (existing && existing.expires > Date.now()) return false

    this.locks.set(this.name, {
      owner: this.owner(),
      // A lock with no expiry would survive a crashed holder forever, so an
      // unbounded lock is stored as far-future rather than as "no expiry".
      expires: this.seconds === 0 ? Number.MAX_SAFE_INTEGER : Date.now() + this.seconds * 1000
    })

    return true
  }

  async release(): Promise<boolean> {
    if (!(await this.isOwnedByCurrentProcess())) return false

    this.locks.delete(this.name)

    return true
  }

  override async refresh(seconds?: number): Promise<boolean> {
    if (!(await this.isOwnedByCurrentProcess())) return false

    const extend = seconds ?? this.seconds

    this.locks.set(this.name, {
      owner: this.owner(),
      expires: extend === 0 ? Number.MAX_SAFE_INTEGER : Date.now() + extend * 1000
    })

    return true
  }

  protected async currentOwner(): Promise<string | null> {
    const existing = this.locks.get(this.name)

    if (!existing || existing.expires <= Date.now()) return null

    return existing.owner
  }
}
