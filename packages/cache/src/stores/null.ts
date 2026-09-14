import type { Store } from '../store.ts'

/**
 * A cache that stores nothing.
 *
 * `CACHE_STORE=null` was a boot error, so proving a page still works with the
 * cache off meant editing the config — which is exactly the change nobody wants
 * to make while diagnosing a cache that is lying to them.
 *
 * Every read misses and every write reports success. Reporting success is the
 * deliberate half: a `put()` returning `false` means "the store tried and
 * failed", which now dispatches a failure event — and a store that is doing what
 * it was configured to do has not failed.
 */
export class NullStore implements Store {
  readonly prefix = ''

  async get<T = unknown>(_key: string): Promise<T | null> {
    return null
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    return Object.fromEntries(keys.map((key) => [key, null]))
  }

  async put(_key: string, _value: unknown, _seconds: number): Promise<boolean> {
    return true
  }

  async putMany(_values: Record<string, unknown>, _seconds: number): Promise<boolean> {
    return true
  }

  /**
   * `false`, unlike `put`.
   *
   * `add` answers "did I win the race", and with nothing stored nobody ever
   * wins. A `true` here would let two callers both believe they hold a slot —
   * which is how `add`-based locking silently stops locking.
   */
  async add(_key: string, _value: unknown, _seconds: number): Promise<boolean> {
    return false
  }

  async increment(_key: string, value = 1): Promise<number | false> {
    return value
  }

  async decrement(_key: string, value = 1): Promise<number | false> {
    return -value
  }

  async forever(_key: string, _value: unknown): Promise<boolean> {
    return true
  }

  async forget(_key: string): Promise<boolean> {
    return true
  }

  async flush(): Promise<boolean> {
    return true
  }
}
