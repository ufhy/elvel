/**
 * What every cache driver has to provide — `Illuminate\Contracts\Cache\Store`.
 *
 * TTLs are always **seconds** at this level; `0` means forever. Normalising a
 * `Date` or a null into seconds is the Repository's job, so a driver never has to
 * think about it.
 */
export interface Store {
  get<T = unknown>(key: string): Promise<T | null>

  /** Missing keys come back as `null`, so the caller can tell them apart. */
  many<T = unknown>(keys: string[]): Promise<Record<string, T | null>>

  put(key: string, value: unknown, seconds: number): Promise<boolean>

  putMany(values: Record<string, unknown>, seconds: number): Promise<boolean>

  /** Write only when the key is absent. Must be atomic to be worth anything. */
  add(key: string, value: unknown, seconds: number): Promise<boolean>

  increment(key: string, value?: number): Promise<number | false>

  decrement(key: string, value?: number): Promise<number | false>

  forever(key: string, value: unknown): Promise<boolean>

  forget(key: string): Promise<boolean>

  flush(): Promise<boolean>

  /** Prefix applied to every key, so two apps can share one server. */
  readonly prefix: string
}

/** A store that can hand out atomic locks — `LockProvider`. */
export interface LockProvider {
  lock(name: string, seconds?: number, owner?: string): Lock

  /** Rebuild a lock from an owner token, to release it from elsewhere. */
  restoreLock(name: string, owner: string): Lock
}

export function isLockProvider(store: Store): store is Store & LockProvider {
  return typeof (store as Partial<LockProvider>).lock === 'function'
}

/** Thrown by `block()` when the lock could not be acquired in time. */
export class LockTimeoutError extends Error {
  constructor(name: string) {
    super(`Timed out waiting for the lock [${name}].`)
    this.name = 'LockTimeoutError'
  }
}

/**
 * An atomic lock — `Illuminate\Cache\Lock`.
 *
 * The owner token is the point of the class: without it any process could
 * release a lock it never held, which turns a mutex into a suggestion.
 */
export abstract class Lock {
  /** Milliseconds between attempts while blocking. */
  protected sleepMilliseconds = 250

  constructor(
    readonly name: string,
    protected readonly seconds = 0,
    private readonly ownerToken: string = Lock.randomOwner()
  ) {}

  abstract acquire(): Promise<boolean>

  abstract release(): Promise<boolean>

  /** The owner currently written in the driver, or null when free. */
  protected abstract currentOwner(): Promise<string | null>

  /**
   * Take the lock. With a callback, run it and release afterwards; without one,
   * report whether the lock was taken.
   */
  async get<T>(callback?: () => Promise<T> | T): Promise<T | boolean> {
    const acquired = await this.acquire()

    if (!acquired || !callback) return acquired

    try {
      return await callback()
    } finally {
      await this.release()
    }
  }

  /**
   * Wait up to `seconds` for the lock, then throw.
   *
   * The wait is measured against the clock rather than counted in attempts, so a
   * slow driver cannot stretch the timeout.
   */
  async block<T>(seconds: number, callback?: () => Promise<T> | T): Promise<T | boolean> {
    const deadline = Date.now() + seconds * 1000

    while (!(await this.acquire())) {
      if (Date.now() + this.sleepMilliseconds > deadline) {
        throw new LockTimeoutError(this.name)
      }

      await Bun.sleep(this.sleepMilliseconds)
    }

    if (!callback) return true

    try {
      return await callback()
    } finally {
      await this.release()
    }
  }

  /** Extend the lock. Drivers that cannot do this say so. */
  refresh(_seconds?: number): Promise<boolean> {
    throw new Error(`The [${this.constructor.name}] driver does not support refreshing locks.`)
  }

  owner(): string {
    return this.ownerToken
  }

  async isOwnedByCurrentProcess(): Promise<boolean> {
    return this.isOwnedBy(this.ownerToken)
  }

  async isOwnedBy(owner: string | null): Promise<boolean> {
    return (await this.currentOwner()) === owner
  }

  /** Change the polling interval used by `block()`. */
  betweenBlockedAttemptsSleepFor(milliseconds: number): this {
    this.sleepMilliseconds = milliseconds

    return this
  }

  static randomOwner(): string {
    return crypto.randomUUID().replaceAll('-', '')
  }
}
