import { requestSlot } from '@elvel/core'
import type { EntriesRepository } from './contracts.ts'
import { isTerminable } from './contracts.ts'
import type { IncomingEntry } from './entry.ts'
import type { EntryTypeName } from './entry-type.ts'
import type { EntryUpdate } from './entry-update.ts'
import { notInstalledError, tableIsMissing } from './installed.ts'

/** A filter answering "should this be kept". Every registered one must agree. */
export type EntryFilter = (entry: IncomingEntry) => boolean

/**
 * Answers "is this whole unit of work worth keeping".
 *
 * Different from {@link EntryFilter} in the way that matters most in
 * production: a filter that judges entries one at a time keeps an exception and
 * throws away the queries that caused it, which is the entry without the reason
 * for it. This one sees the batch and decides for all of it.
 */
export type BatchFilter = (entries: IncomingEntry[]) => boolean

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
  /**
   * When this unit of work began, on the monotonic clock.
   *
   * `performance.now()` and not `Date.now()`: the wall clock can step, and the
   * only thing this is used for is subtracting two readings taken milliseconds
   * apart. It is what lets a detail page place entries on a time axis at all —
   * `created_at` is stored to the second, so every entry in a batch shares it.
   */
  startedAt: number
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

  private readonly batchFilters: BatchFilter[] = []

  private readonly tagCallbacks: TagCallback[] = []

  private readonly afterStoringHooks: AfterStoringHook[] = []

  /** Turned on per unit of work by {@link start}; off means nothing records. */
  private enabled = false

  /** So the missing-tables instruction is given once rather than every request. */
  private warnedNotInstalled = false

  /**
   * Paused by hand, through `lens:pause`.
   *
   * Telescope reads the cache key on every `startRecording()`, which it can do
   * because a PHP cache read is synchronous. Opening a batch here happens in a
   * synchronous hook — it has to, `enterWith` applies to the current execution
   * — so the flag is held and refreshed asynchronously instead: once at boot,
   * and after each flush. A pause takes effect from the next request rather
   * than the current one, which is the whole of the difference.
   */
  private paused = false

  /**
   * The monitored tags, as of the last refresh.
   *
   * Held rather than queried for the same reason `paused` is: opening a batch
   * and recording an entry are both synchronous, and asking the database
   * whether a tag is monitored would make every recorded entry await. Refreshed
   * at boot and after each flush, so a tag switched on from the dashboard takes
   * effect from the next unit of work rather than the current one.
   */
  private monitored: string[] = []

  /** The gate, if the application installed one. */
  private authorise: ((request: Request) => boolean | Promise<boolean>) | undefined

  /**
   * What never reaches a row, held here so the application can add to it.
   *
   * Telescope keeps these as statics on `Telescope` and the published provider
   * stub appends to them — `cookie`, `x-csrf-token` and `_token` outside local.
   * Same seam, same defaults: `authorization` is Telescope's list minus
   * `php-auth-pw`, which is a PHP CGI variable with no counterpart.
   */
  private hiddenRequestHeaders = ['authorization']

  private hiddenRequestParameters = ['password', 'password_confirmation']

  private hiddenResponseParameters: string[] = []

  /**
   * How many batches have finished storing.
   *
   * A flush is fire-and-forget by nature — it happens after the response, and
   * nothing is waiting on it — which leaves a test with no moment to read the
   * table at. Waiting for the write to be *in flight* is not enough either: at
   * the point a test asks, the flush has often not started. So the count is
   * exposed and a test waits for it to reach a number, which is the one thing
   * that cannot be raced.
   */
  private completed = 0

  /**
   * Patches whose row was not there, waiting for another go.
   *
   * The channel is eventually consistent by design: a job entry is written by
   * whatever dispatched it and patched by the worker that ran it, and a fast job
   * finishes before the dispatching request has flushed. Telescope hands these
   * to a queued job that retries three times; retrying here on the next flush
   * needs no queue, no job class, and cannot record itself — and it works across
   * processes for the same reason Telescope's does, because the retry re-reads a
   * table both of them share.
   */
  private waiting: Array<{ update: EntryUpdate; attempts: number }> = []

  constructor(private readonly report: (error: unknown) => void = () => {}) {}

  /** How many times a patch is retried before it is given up on. */
  static readonly updateAttempts = 3

  /**
   * How many patches may wait at once.
   *
   * A bound rather than a promise to stay small: if something is producing
   * patches for rows that will never exist, the memory this holds must not grow
   * with it.
   */
  static readonly maxWaiting = 500

  /**
   * Open a batch for this unit of work.
   *
   * Must be reached from a synchronous hook the first time in a request, because
   * that is when the underlying context is entered. Calling it twice in one unit
   * of work keeps the first batch — the HTTP layer and an error handler may both
   * try, and the entries already recorded must not be dropped.
   */
  start(): Batch | undefined {
    if (!this.enabled || this.paused) return undefined

    const open = batchSlot.get()

    if (open !== undefined) return open

    const batch: Batch = {
      batchId: crypto.randomUUID(),
      startedAt: performance.now(),
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

  /** Whether recording is paused by hand. */
  isPaused(): boolean {
    return this.paused
  }

  /** Set from the cache, at boot and after each flush. */
  setPaused(paused: boolean): void {
    this.paused = paused
  }

  /** Set from storage, at boot and after each flush. */
  setMonitoredTags(tags: string[]): void {
    this.monitored = tags
  }

  monitoredTags(): string[] {
    return this.monitored
  }

  /**
   * Who may read the dashboard — Telescope's `Telescope::auth()`.
   *
   * Closed until an application says otherwise. Telescope's default is
   * `app()->environment('local')`, and that is the shape the published provider
   * stub carries; the default *here* is a refusal, because `local` plus an empty
   * `HOST` binds every interface on the machine, which is what the spike's
   * security review objected to.
   */
  auth(callback: (request: Request) => boolean | Promise<boolean>): this {
    this.authorise = callback

    return this
  }

  async check(request: Request): Promise<boolean> {
    if (this.authorise === undefined) return false

    try {
      return await this.authorise(request)
    } catch {
      return false
    }
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

    /**
     * Stamped here rather than by each watcher, so every type gets it and no
     * watcher has to know a batch has a start.
     */
    entry.content = {
      ...entry.content,
      offsetMs: Math.max(0, Math.round(performance.now() - batch.startedAt))
    }

    entry.withType(type).withBatch(batch.batchId).withMonitored(this.monitored)

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

    const { updates, batchId } = batch

    /**
     * The batch is judged before anything is written, and suppressed, because a
     * filter belongs to the application and may query anything.
     */
    const entries = this.keeps(batch.entries) ? batch.entries : []

    batch.flushed = true

    if (entries.length === 0 && updates.length === 0 && this.waiting.length === 0) {
      await this.terminate(repository)
      this.completed++

      return
    }

    batch.suppressed++

    try {
      await repository.store(entries)

      /**
       * Patches from before go first.
       *
       * Their rows are the older ones, so they are the likelier to exist by now
       * — and a patch that has waited should not queue behind one that has not.
       */
      const retrying = this.waiting.splice(0, this.waiting.length)
      const pending = await repository.update([...retrying.map((held) => held.update), ...updates])

      this.hold(retrying, pending, batchId)

      for (const hook of this.afterStoringHooks) hook(entries, batchId)
    } catch (error) {
      /**
       * Said once, not once per request.
       *
       * A recorder whose tables are missing reports on every single request,
       * which buries whatever the log was for. The instruction does not change
       * between requests, so neither should the line.
       */
      if (tableIsMissing(error)) {
        if (!this.warnedNotInstalled) {
          this.warnedNotInstalled = true
          this.report(notInstalledError())
        }
      } else {
        this.report(error)
      }
    } finally {
      batch.suppressed--

      await this.terminate(repository)
      this.completed++
    }
  }

  hideRequestHeaders(headers: string[]): this {
    this.hiddenRequestHeaders = [...new Set([...this.hiddenRequestHeaders, ...headers])]

    return this
  }

  hideRequestParameters(keys: string[]): this {
    this.hiddenRequestParameters = [...new Set([...this.hiddenRequestParameters, ...keys])]

    return this
  }

  hideResponseParameters(keys: string[]): this {
    this.hiddenResponseParameters = [...new Set([...this.hiddenResponseParameters, ...keys])]

    return this
  }

  hidden(): { headers: string[]; parameters: string[]; responseParameters: string[] } {
    return {
      headers: this.hiddenRequestHeaders,
      parameters: this.hiddenRequestParameters,
      responseParameters: this.hiddenResponseParameters
    }
  }

  /**
   * Keep what still found no row, and give up on what has waited long enough.
   *
   * Given up on *loudly*: a patch that never lands leaves an entry saying
   * something untrue — a job stuck at `pending` that in fact ran — and a
   * recorder that lies quietly is worse than one that records nothing.
   */
  private hold(
    retried: Array<{ update: EntryUpdate; attempts: number }>,
    pending: EntryUpdate[],
    batchId: string
  ): void {
    if (pending.length === 0) return

    const attemptsOf = new Map(retried.map((held) => [held.update, held.attempts]))
    const abandoned: EntryUpdate[] = []

    for (const update of pending) {
      const attempts = (attemptsOf.get(update) ?? 0) + 1

      if (attempts >= Recorder.updateAttempts) {
        abandoned.push(update)

        continue
      }

      if (this.waiting.length < Recorder.maxWaiting) this.waiting.push({ update, attempts })
      else abandoned.push(update)
    }

    if (abandoned.length > 0) {
      this.report(
        new Error(
          `[lens] gave up on ${String(abandoned.length)} entry update(s) after ${String(
            Recorder.updateAttempts
          )} attempts, last seen in batch ${batchId}`
        )
      )
    }
  }

  /**
   * Do the batch filters all agree this is worth keeping?
   *
   * A filter that throws refuses nothing: the alternative is that a broken
   * predicate silently empties the recorder, which is the failure nobody would
   * think to look for.
   */
  private keeps(entries: IncomingEntry[]): boolean {
    if (this.batchFilters.length === 0 || entries.length === 0) return true

    return this.withoutRecording(() => {
      for (const filter of this.batchFilters) {
        try {
          if (!filter(entries)) return false
        } catch (error) {
          this.report(error)
        }
      }

      return true
    })
  }

  /** How many patches are waiting for their row. */
  pendingUpdates(): number {
    return this.waiting.length
  }

  /** Registered filters must all agree before an entry is kept. */
  filter(filter: EntryFilter): this {
    this.filters.push(filter)

    return this
  }

  /**
   * Judge the whole unit of work at once, when it is about to be stored.
   *
   * Telescope's `filterBatch`, and the shape its documentation reaches for in
   * production. Every registered one must agree; if any refuses, the entries go
   * and the patches still apply — a patch is about a row somebody else already
   * decided to keep.
   */
  filterBatch(filter: BatchFilter): this {
    this.batchFilters.push(filter)

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

  /** How many batches have finished storing — see {@link completed}. */
  flushes(): number {
    return this.completed
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
