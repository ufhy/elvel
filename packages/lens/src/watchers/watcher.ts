import type { ApplicationContract } from '@elvel/contracts'

/** A watcher's slice of `lens.watchers`, minus the `enabled` flag. */
export type WatcherOptions = Record<string, unknown>

/**
 * A source of entries.
 *
 * Deliberately almost empty. A watcher's whole job is to subscribe to something
 * the framework already emits and turn it into an entry — it never touches
 * storage, never decides whether an entry is kept, and never knows which batch
 * it is in. That boundary is what lets a watcher be read on its own.
 */
export abstract class Watcher {
  constructor(protected readonly options: WatcherOptions = {}) {}

  abstract register(app: ApplicationContract): void

  protected option<T>(key: string, fallback: T): T {
    const value = this.options[key]

    return value === undefined ? fallback : (value as T)
  }
}
