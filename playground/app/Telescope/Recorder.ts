import { type ApplicationContract, inRequestContext, requestSlot } from '@elvel/core'
import { formatDateTime } from '@elvel/database'

/** One thing that happened. */
export type Entry = {
  type: string
  content: Record<string, unknown>
  recordedAt: Date
}

/** Everything one request did, and the id that ties it together. */
export type Batch = {
  id: string
  entries: Entry[]
  /** Set once the response has been recorded, so a second hook does nothing. */
  completed: boolean
}

export const TABLE = 'telescope_entries'

/** Longest SQL kept. A query with a thousand-item `IN` is not worth megabytes. */
const MAX_SQL = 2_000

/**
 * A value's **shape**, never its content.
 *
 * The security review of the first version was right twice over, and both paths
 * were ones this file's own comment had warned about and then walked past:
 *
 * - `cache.hit` and `cache.written` carry the cached **value**
 *   (`packages/cache/src/repository.ts:58` and `:92`), so a cached token, email
 *   or one-time code went into the table as plain text
 * - a query's `bindings` are its parameters, so
 *   `insert into "user" ("email", "password_hash") values (?, ?)` stored both
 *
 * Neither is a hypothetical: a debugging tool is exactly the thing somebody
 * leaves running and later reads over a shoulder, and this table has no
 * encryption and a permissive read route. What is useful for debugging is almost
 * always the shape — "a 42-character string", "an array of 3" — so that is what
 * is kept, and the value never leaves the process.
 */
export function shapeOf(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  if (typeof value === 'string') return `string(${value.length})`
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return typeof value
  }
  if (Array.isArray(value)) return `array(${value.length})`
  if (value instanceof Date) return 'Date'

  return `object(${Object.keys(value as object).length})`
}

/** SQL, truncated, with a marker rather than a silent cut. */
export function trimSql(sql: string): string {
  return sql.length <= MAX_SQL ? sql : `${sql.slice(0, MAX_SQL)}… (${sql.length} chars)`
}

/**
 * The batch belonging to the request in flight.
 *
 * A slot in the one request context rather than a `Map` keyed by request: the
 * watchers below never receive the `Request` object — an event listener is handed
 * a payload and nothing else — so there would be nothing to key by. This is the
 * whole reason the spike is small.
 *
 * Set lazily, from whichever watcher fires first, and that works even from an
 * async listener: `@elvel/http` opens the context in its first synchronous
 * `onRequest` hook, so `set` finds a context that belongs to this request and
 * mutates it instead of entering a new one.
 */
const batch = requestSlot<Batch>('telescope')

/**
 * Buffers what happened and writes it once.
 *
 * Writing per event would put an `insert` between every two of the application's
 * own queries, which is both slow and misleading — the timings a profiler is
 * asked to explain would be the profiler's. So entries accumulate in memory and
 * the response flushes them in one statement.
 */
export class Recorder {
  /**
   * True while an entry is being written.
   *
   * Writing an entry is itself a query, and a query is an event — so anything
   * listening broadly is listening to the recorder's own footsteps. Found by
   * hanging the migration: the wildcard listener caught `db.query` from the
   * recorder's `insert`, recorded it, and outside a request that writes
   * immediately, which emitted another `db.query`. A name-based guard fixed that
   * one path; this one closes every path, including the ones a later watcher
   * would add.
   */
  private writing = false

  /**
   * The write in flight, for anything that needs to wait for it.
   *
   * `onAfterResponse` is fire-and-forget: `app.handle()` returns before the hook
   * finishes, so a test that asserts on the table right after a request reads it
   * empty. That is not a bug in the recorder — the whole point is to be off the
   * path the caller waits on — but it does mean anything observing it has to be
   * able to wait, and a fixed `sleep` in a test is a flake with a timer on it.
   */
  private settling: Promise<unknown> = Promise.resolve()

  /**
   * How many batches have been written. The only way to observe the flush.
   *
   * `settled()` alone was not enough, and the reason is worth writing down: it
   * can only await a write that has *started*, and the hook that starts one is
   * fire-and-forget — so a test calling it immediately after a request awaited
   * the previous batch, found it long resolved, and read an empty table. The
   * count distinguishes "not yet" from "never", which a `sleep` cannot.
   */
  private written = 0

  constructor(private readonly app: ApplicationContract) {}

  /** The batch for this request, opened on first use. */
  current(): Batch {
    const existing = batch.get()

    if (existing !== undefined) return existing

    const opened: Batch = { id: crypto.randomUUID(), entries: [], completed: false }
    batch.set(opened)

    return opened
  }

  /**
   * Whether this is a request, and therefore has a response to flush against.
   *
   * `inRequestContext()`, not "has a batch been opened" — which was the first
   * version and could never become true: `record` only buffered when a batch
   * existed, and only buffering opened one. Every entry took the write-immediately
   * path and landed with a null `batch_id`, so nothing was correlated with
   * anything. The probe that found it printed `inContext=true batch=none`.
   */
  inRequest(): boolean {
    return inRequestContext()
  }

  /**
   * Record one entry, if this is a request.
   *
   * **Outside a request, nothing is recorded — deliberately, and this is the
   * spike's boundary.** The first version wrote such entries one insert at a
   * time, since there is no response to flush against, and `elvel db:seed`
   * promptly hung: seeding fires a model event per row, each of which awaited its
   * own `insert` before the next row could be written.
   *
   * Telescope does watch commands and queued jobs, and doing it properly means
   * giving those their own batch — a worker would open one per job, a command one
   * per run. That is a design decision with its own flush points, not something
   * to smuggle in behind a request-shaped recorder, so the spike stops here and
   * says so.
   */
  record(type: string, content: Record<string, unknown>): void {
    if (this.writing || !this.inRequest()) return

    this.current().entries.push({ type, content, recordedAt: new Date() })
  }

  /**
   * Record the response and write everything this request collected. Once.
   *
   * Two hooks call this, and on one path **both** of them run: a 404 goes through
   * Elysia's `onAfterResponse` and through `RequestLifecycle.finishing`, so the
   * first version wrote two `request` entries for every unmatched URL. Whichever
   * arrives second finds the batch completed and does nothing.
   */
  async complete(entry: Record<string, unknown>): Promise<number> {
    const open = this.current()

    if (open.completed) return 0

    open.completed = true
    this.record('request', entry)

    return this.flush()
  }

  /** Write everything collected so far, and forget it. */
  async flush(): Promise<number> {
    const open = batch.get()

    if (open === undefined || open.entries.length === 0) return 0

    const entries = open.entries.splice(0, open.entries.length)

    this.settling = this.write(open.id, entries)
    await this.settling
    this.written++

    return entries.length
  }

  /**
   * Writes, and **never throws**.
   *
   * The first version let the error out. A `Date` in the payload is not bindable
   * by the sqlite driver, the `insert` rejected, and because the non-request path
   * calls this as `void this.write(…)` the rejection was unhandled — which took
   * the whole server down on the first request. A profiler that stops the
   * application is worse than no profiler, so the failure is reported and
   * swallowed.
   */
  /** Resolves once nothing is being written. For shutdown. */
  async settled(): Promise<void> {
    await this.settling
  }

  /** Batches written so far. */
  flushes(): number {
    return this.written
  }

  /**
   * Wait until one more batch has been written than when `since` was taken.
   *
   * Bounded, and it throws rather than hanging: a spike that waits forever for an
   * event that will never come is a spike that looks like a slow test.
   */
  async drained(since: number, timeoutMs = 2_000): Promise<void> {
    const until = Date.now() + timeoutMs

    while (this.written <= since) {
      if (Date.now() > until) {
        throw new Error(`no batch was written within ${timeoutMs}ms (still ${this.written})`)
      }

      await Bun.sleep(5)
    }

    await this.settled()
  }

  private async write(batchId: string | null, entries: Entry[]): Promise<void> {
    this.writing = true

    try {
      const table = await this.app.make('db').table(TABLE)

      await table.insert(
        entries.map((entry) => ({
          batch_id: batchId,
          type: entry.type,
          content: JSON.stringify(entry.content),
          recorded_at: formatDateTime(entry.recordedAt)
        }))
      )
    } catch (error) {
      this.app.make('log').error('telescope could not record', {
        error: error instanceof Error ? error.message : String(error),
        entries: entries.length
      })
    } finally {
      this.writing = false
    }
  }
}
