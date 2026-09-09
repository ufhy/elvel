import { requestSlot } from '@elvel/core'
import type { EntriesRepository } from './contracts.ts'
import { isTerminable } from './contracts.ts'
import type { IncomingEntry } from './entry.ts'
import type { EntryTypeName } from './entry-type.ts'
import type { EntryUpdate } from './entry-update.ts'

/** A filter answering "should this be kept". Every registered one must agree. */
export type EntryFilter = (entry: IncomingEntry) => boolean

/** Adds tags to every entry, whatever its type. */
export type TagCallback = (entry: IncomingEntry) => string[]

export type AfterStoringHook = (entries: IncomingEntry[], batchId: string) => void

/**
 * One unit of work's worth of recording.
 *
 * A request, a queued job, or a console command — whichever it is, everything
 * recorded within it shares a batch id, and the dashboard groups by that: the
 * queries a request ran are the queries whose `batch_id` matches the request's.
 */
export type Batch = {
  batchId: string
  entries: IncomingEntry[]
  updates: EntryUpdate[]
  /**
   * How deep we are inside {@link Recorder.withoutRecording}.
   *
   * A counter and not a boolean so nesting restores correctly: a filter that
   * queries the database, inside a flush that is already suppressed, must not
   * un-suppress the flush when it returns.
   */
  suppressed: number
  /** Set once the batch has been handed to storage, so a second flush is a no-op. */
  flushed: boolean
}

/**
 * The batch lives in the request context, not in a static.
 *
 * This is the one structural departure from Laravel Telescope, and it is forced.
 * Telescope keeps `$entriesQueue` in a static property, which is safe under
 * PHP-FPM because a process serves exactly one request at a time. Bun serves
 * many at once in one process: a static queue would collect entries from every
 * in-flight request into whichever one flushed first, and the dashboard would
 * show one request having run another's queries.
 *
 * So the queue is a slot, keyed per unit of work by the same machinery that
 * carries the auth session and the cookie bag. Entries recorded inside a
 * request reach that request's batch and no other, with no locking and no
 * request id threaded through every call.
 */
const batchSlot = requestSlot<Batch>('lens')

/**
 * Holds what is process-wide — filters, tag callbacks, hidden keys, the config —
 * while every entry queue lives in a slot.
 *
 * Bound as the `lens` singleton, so a watcher reaches it the way anything else
 * in Elvel reaches a manager rather than through a static.
 */
export class Recorder {
  private readonly filters: EntryFilter[] = []

  private readonly tagCallbacks: TagCallback[] = []

  private readonly afterStoringHooks: AfterStoringHook[] = []

  /** Turned on per unit of work by {@link start}; off means nothing records. */
  private enabled = false

  constructor(private readonly report: (error: unknown) => void = () => {}) {}

  /**
   * Open a batch for this unit of work.
   *
   * Must be reached from a synchronous hook the first time in a request, because
   * that is when the underlying context is entered. Calling it twice in one unit
   * of work keeps the first batch — the HTTP layer and an error handler may both
   * try, and the entries already recorded must not be dropped.
   */
  start(): Batch | undefined {
    if (!this.enabled) return undefined

    const open = batchSlot.get()

    if (open !== undefined) return open

    const batch: Batch = {
      batchId: crypto.randomUUID(),
      entries: [],
      updates: [],
      suppressed: 0,
      flushed: false
    }

    batchSlot.set(batch)

    return batch
  }

  /** Whether the recorder may run at all, set from config at boot. */
  enable(enabled: boolean): void {
    this.enabled = enabled
  }

  /**
   * True when there is an open batch and nothing is suppressing it.
   *
   * A watcher checks this before doing any work at all — building an entry costs
   * string formatting and, for queries, a stack trace, and none of that should
   * be paid when the answer is going to be thrown away.
   */
  recording(): boolean {
    const batch = batchSlot.get()

    return batch !== undefined && batch.suppressed === 0 && !batch.flushed
  }

  /**
   * Run `body` with recording suppressed, then restore it.
   *
   * This is what keeps the recorder from recording itself. Storing a batch runs
   * inserts, and inserts emit the very event the query watcher listens for — the
   * first thing that went wrong in the spike this package came from was a
   * recorder that grew a new entry for each entry it wrote, forever.
   *
   * Restoring rather than clearing is the important half: nested calls are
   * ordinary here, since a filter or a tag callback belongs to the application
   * and may touch anything.
   */
  withoutRecording<T>(body: () => T): T {
    const batch = batchSlot.get()

    if (batch === undefined) return body()

    batch.suppressed++

    try {
      return body()
    } finally {
      batch.suppressed--
    }
  }

  /**
   * Queue an entry, if every filter agrees it should be kept.
   *
   * The filters and tag callbacks run suppressed, because they are the
   * application's code and are perfectly entitled to query the database.
   */
  record(type: EntryTypeName, entry: IncomingEntry): void {
    if (!this.recording()) return

    const batch = batchSlot.get()

    if (batch === undefined) return

    entry.withType(type).withBatch(batch.batchId)

    this.withoutRecording(() => {
      try {
        for (const tag of this.tagCallbacks) entry.withTags(tag(entry))

        if (!this.filters.every((filter) => filter(entry))) return

        batch.entries.push(entry)
      } catch (error) {
        // A broken filter must not break the request it was filtering.
        this.report(error)
      }
    })
  }

  /** Queue a patch. Unlike an entry, a patch is never filtered. */
  recordUpdate(update: EntryUpdate): void {
    const batch = batchSlot.get()

    if (batch === undefined || batch.suppressed > 0) return

    batch.updates.push(update)
  }

  /**
   * Hand this unit of work's batch to storage and close it.
   *
   * Never throws. A recorder that can fail a request it was only watching is
   * worse than no recorder — the spike lost a whole server to an unhandled
   * rejection from a fire-and-forget write.
   */
  async store(repository: EntriesRepository, given?: Batch): Promise<void> {
    /**
     * The batch may be passed in rather than read from the slot.
     *
     * Elysia's `onAfterResponse` is documented here as possibly running outside
     * the execution context the handler ran in — `deferPlugin` in `@elvel/http`
     * keeps its queue in a `WeakMap` keyed by `Request` for exactly that reason.
     * A flush from there hands the batch over directly; a flush from inside the
     * work, as a console command does, lets the slot supply it.
     */
    const batch = given ?? batchSlot.get()

    if (batch === undefined || batch.flushed) return

    const { entries, updates, batchId } = batch

    batch.flushed = true

    if (entries.length === 0 && updates.length === 0) {
      await this.terminate(repository)

      return
    }

    batch.suppressed++

    try {
      await repository.store(entries)

      const pending = await repository.update(updates)

      if (pending.length > 0) {
        /**
         * Patches whose rows are not there yet.
         *
         * Telescope hands these to a queued job that retries three times. Until
         * the job watcher lands there is nothing that produces them, so they are
         * reported rather than silently dropped — a count here would be a real
         * bug, not a race.
         */
        this.report(
          new Error(`[lens] ${pending.length} entry update(s) found no row in batch ${batchId}`)
        )
      }

      for (const hook of this.afterStoringHooks) hook(entries, batchId)
    } catch (error) {
      this.report(error)
    } finally {
      batch.suppressed--

      await this.terminate(repository)
    }
  }

  /** Registered filters must all agree before an entry is kept. */
  filter(filter: EntryFilter): this {
    this.filters.push(filter)

    return this
  }

  tag(callback: TagCallback): this {
    this.tagCallbacks.push(callback)

    return this
  }

  afterStoring(hook: AfterStoringHook): this {
    this.afterStoringHooks.push(hook)

    return this
  }

  /** The open batch's id, for a watcher that needs to correlate. */
  batchId(): string | undefined {
    return batchSlot.get()?.batchId
  }

  private async terminate(repository: EntriesRepository): Promise<void> {
    if (!isTerminable(repository)) return

    try {
      await repository.terminate()
    } catch (error) {
      this.report(error)
    }
  }
}
