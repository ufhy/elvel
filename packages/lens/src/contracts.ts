import type { IncomingEntry } from './entry.ts'
import type { EntryResult } from './entry-result.ts'
import type { EntryTypeName } from './entry-type.ts'
import type { EntryUpdate } from './entry-update.ts'
import type { EntryQueryOptions } from './storage/query-options.ts'

/**
 * Reading and writing entries. The one contract a driver must implement.
 *
 * The other three below are separate on purpose. A driver that can store and
 * read but cannot prune — a stream, a remote sink — implements this and nothing
 * else, and the `lens:prune` command asks the container for
 * {@link PrunableRepository} and fails loudly rather than calling a `prune()`
 * that was stubbed out to satisfy a wider interface.
 */
export type EntriesRepository = {
  find(uuid: string): Promise<EntryResult | undefined>

  get(type: EntryTypeName | undefined, options: EntryQueryOptions): Promise<EntryResult[]>

  /**
   * How many entries of a type there are.
   *
   * Its own method because the alternative is counting a page and calling that
   * a total: `lens:status` did exactly that and reported `200` for two hundred
   * thousand requests, which is the page size wearing a number's clothes.
   */
  count(type?: EntryTypeName): Promise<number>

  store(entries: IncomingEntry[]): Promise<void>

  /** Returns the patches whose rows were not found, to be retried. */
  update(updates: EntryUpdate[]): Promise<EntryUpdate[]>

  /** Tags whose entries survive a filter that would otherwise drop them. */
  monitoring(): Promise<string[]>

  isMonitoring(tags: string[]): Promise<boolean>

  monitor(tags: string[]): Promise<void>

  stopMonitoring(tags: string[]): Promise<void>
}

/**
 * Everything the `database` driver happens to implement.
 *
 * A convenience for a driver that implements all four, not a replacement for
 * them: nothing asks for this type, and a command still narrows to the one
 * contract it needs.
 */
export type EntriesDriver = EntriesRepository &
  ClearableRepository &
  PrunableRepository &
  RecentBatchesRepository &
  TerminableRepository

export type ClearableRepository = {
  clear(): Promise<void>
}

/** A batch as storage remembers it, which is less than the ring remembers. */
export type StoredBatch = {
  batchId: string
  at: number
  /** The kinds of entry in it, with counts — enough for a list row. */
  types: Record<string, number>
  count: number
}

/**
 * Recent units of work, whoever recorded them.
 *
 * The inspection bar's window onto other processes, and the reason it is a
 * contract of its own rather than a method on {@link EntriesRepository}: the
 * bar's own ring lives in memory and answers for this process only. `bun elvel
 * dev` runs the queue worker and the scheduler beside the server, and a job's
 * batch is stored from the worker's process — so the database is the only place
 * both can see. A driver that cannot group by batch simply does not implement
 * this, and the bar shows what it has.
 */
export type RecentBatchesRepository = {
  recentBatches(limit: number): Promise<StoredBatch[]>
}

export type PrunableRepository = {
  /** Returns how many rows went. */
  prune(before: Date, keepExceptions: boolean): Promise<number>
}

/**
 * A driver holding per-process state that must be dropped between units of work.
 *
 * Under PHP this contract would be close to pointless — the process ends with
 * the request. Bun's does not: a memoised monitored-tag list would be minutes
 * stale and a connection held across a redeploy would be dead. Anything cached
 * for the life of the process gets released here.
 */
export type TerminableRepository = {
  terminate(): Promise<void>
}

/**
 * Generic so the narrowing keeps what the caller already knew.
 *
 * `isPrunable(repository)` has to leave the value usable as an
 * {@link EntriesRepository} too — a guard returning bare `PrunableRepository`
 * would trade one half of the type away for the other.
 */
export function isClearable<T>(driver: T): driver is T & ClearableRepository {
  return typeof (driver as ClearableRepository)?.clear === 'function'
}

export function isPrunable<T>(driver: T): driver is T & PrunableRepository {
  return typeof (driver as PrunableRepository)?.prune === 'function'
}

export function isTerminable<T>(driver: T): driver is T & TerminableRepository {
  return typeof (driver as TerminableRepository)?.terminate === 'function'
}

export function knowsBatches<T>(driver: T): driver is T & RecentBatchesRepository {
  return typeof (driver as RecentBatchesRepository)?.recentBatches === 'function'
}
