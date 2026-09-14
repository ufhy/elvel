import type { LockProvider, Store } from '../store.ts'
import { isLockProvider, type Lock } from '../store.ts'

/**
 * A chain of stores, tried in order.
 *
 * A cache is the one part of a system whose entire premise is that losing it
 * costs latency and not correctness — and a Redis that stops answering was
 * turning every cached read into an exception, which is the opposite of that
 * premise.
 *
 * A read falls through to the next store; a write goes to the **first store
 * that takes it** and stops there, because writing to both would leave two
 * copies with different lifetimes and the fallback would keep serving a stale
 * one long after the primary came back.
 *
 * Every fall-through is announced. A cache that silently degrades to the file
 * store is a cache whose Redis has been down for a week and nobody knows.
 */
export class FailoverStore implements Store, LockProvider {
  constructor(
    private readonly stores: Store[],
    private readonly onFailover?: (store: number, operation: string, error: unknown) => void
  ) {
    if (stores.length === 0) {
      throw new Error('A failover cache store needs at least one store to try.')
    }
  }

  get prefix(): string {
    return (this.stores[0] as Store).prefix
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.attempt('get', (store) => store.get<T>(key))
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    return this.attempt('many', (store) => store.many<T>(keys))
  }

  async put(key: string, value: unknown, seconds: number): Promise<boolean> {
    return this.attempt('put', (store) => store.put(key, value, seconds))
  }

  async putMany(values: Record<string, unknown>, seconds: number): Promise<boolean> {
    return this.attempt('putMany', (store) => store.putMany(values, seconds))
  }

  async add(key: string, value: unknown, seconds: number): Promise<boolean> {
    return this.attempt('add', (store) => store.add(key, value, seconds))
  }

  async increment(key: string, value?: number): Promise<number | false> {
    return this.attempt('increment', (store) => store.increment(key, value))
  }

  async decrement(key: string, value?: number): Promise<number | false> {
    return this.attempt('decrement', (store) => store.decrement(key, value))
  }

  async forever(key: string, value: unknown): Promise<boolean> {
    return this.attempt('forever', (store) => store.forever(key, value))
  }

  /**
   * Forgetting goes to **every** store that has one.
   *
   * The one operation that must not stop at the first success: a key written to
   * the primary before it failed, and again to the fallback afterwards, exists
   * twice — and a forget that cleared only one of them leaves the other to be
   * served as soon as the chain shifts back.
   */
  async forget(key: string): Promise<boolean> {
    let forgotten = false

    for (const [index, store] of this.stores.entries()) {
      try {
        forgotten = (await store.forget(key)) || forgotten
      } catch (error) {
        this.onFailover?.(index, 'forget', error)
      }
    }

    return forgotten
  }

  /** Same reasoning as `forget`: a copy left behind would come back. */
  async flush(): Promise<boolean> {
    let flushed = false

    for (const [index, store] of this.stores.entries()) {
      try {
        flushed = (await store.flush()) || flushed
      } catch (error) {
        this.onFailover?.(index, 'flush', error)
      }
    }

    return flushed
  }

  /**
   * Locks come from the first store that can provide them, and do not fail over.
   *
   * A lock that moved stores mid-hold is not a lock: the second store knows
   * nothing about the owner token the first one issued, so two callers would
   * both be told they hold it.
   */
  lock(name: string, seconds?: number, owner?: string): Lock {
    return this.lockProvider().lock(name, seconds, owner)
  }

  restoreLock(name: string, owner: string): Lock {
    return this.lockProvider().restoreLock(name, owner)
  }

  private lockProvider(): LockProvider {
    const provider = this.stores.find((store) => isLockProvider(store))

    if (provider === undefined) {
      throw new Error('No store in this failover chain can hand out locks.')
    }

    return provider as Store & LockProvider
  }

  /**
   * Each store in turn; the **last** error if none of them answered.
   *
   * The last rather than the first, for the reason the queue's failover gives:
   * the first is "Redis is down", which is why the chain exists, and the useful
   * one is why the fallback did not work either.
   */
  private async attempt<T>(operation: string, run: (store: Store) => Promise<T>): Promise<T> {
    let last: unknown

    for (const [index, store] of this.stores.entries()) {
      try {
        return await run(store)
      } catch (error) {
        last = error
        this.onFailover?.(index, operation, error)
      }
    }

    throw last
  }
}
