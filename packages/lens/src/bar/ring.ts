import type { IncomingEntry } from '../entry.ts'
import type { EntryUpdate } from '../entry-update.ts'
import { type Summary, summarise } from '../panels/describe.ts'
import type { Verdict } from './baseline.ts'
import { DEFAULTS, type Finding, findings, type Split, split, type Thresholds } from './findings.ts'
import type { Profile } from './profiler.ts'

/** A boundary in the request's own progress — see `lensPlugin`. */
export type Mark = { name: string; atMs: number }

/** One finished unit of work, as the bar reads it back. */
export type BarBatch = {
  /**
   * A cursor, not an identity.
   *
   * The bar asks "what has happened since I last looked", and a UUID cannot
   * answer that. Monotonic within a process, which is all the ring spans.
   */
  seq: number
  batchId: string
  at: number
  method: string
  path: string
  status: number
  durationMs: number
  entries: BarEntry[]
  /**
   * When each stage of the request finished, from its arrival.
   *
   * What the framework was doing between the things a watcher records. Empty for
   * a unit of work that is not an HTTP request.
   */
  marks: Mark[]
  /**
   * A page the browser navigated to, or something that page asked for.
   *
   * The difference between a list and a pile: five reloads and the four calls
   * a page made are not the same kind of thing, and the bar should not print
   * them as if they were.
   */
  kind: 'page' | 'xhr'
  /**
   * What is wrong with this unit of work, decided when it closed.
   *
   * Computed once, here, rather than in the browser: the analysis is the product
   * and it belongs where it can be tested. The client draws what it is told.
   */
  found: Finding[]
  /** Where the time went — three numbers, not one. */
  shape: Split
  /** How this compares to the same route's recent history. */
  verdict?: Verdict
  /** A CPU profile, when one was armed for this request. */
  profile?: Profile
  /**
   * Models built from rows during this unit of work.
   *
   * A counter rather than an entry per model: hydration is synchronous and
   * firing an event per row would make reading a thousand rows a thousand
   * dispatches. The number is what the question was ever about — "this request
   * built 1,240 models" is what exposes a query pulling a whole table.
   */
  hydrated?: number
}

/** The list form: everything but the entries. */
export type BarSummary = Omit<BarBatch, 'entries' | 'found' | 'profile' | 'marks'> & {
  count: number
  /** Which process this came from, so the bar can say what it cannot show. */
  source: 'ring' | 'storage'
  /** How many problems, so a list can mark a bad request without its detail. */
  problems: number
  profiled: boolean
}

/** An entry, flattened to what a list draws. Detail is fetched separately. */
export type BarEntry = {
  uuid: string
  type: string
  offsetMs: number
  tags: string[]
  /** The one-line form, decided in `panels/describe.ts`. */
  summary: Summary
  /**
   * How many entries in this batch are the same thing.
   *
   * The N+1 badge, counted here rather than in the browser: the family hash is
   * already the recorder's answer to "is this the same query", the count is
   * worth a test, and a test in Bun is worth more than one in a page.
   */
  repeats: number
  /**
   * The full content, held for the detail endpoint and never sent with a list.
   *
   * A request entry carries its response body — up to `sizeLimit` kilobytes —
   * and shipping that with the summary meant the bar cost tens of kilobytes on
   * a page nobody had clicked.
   */
  content: Record<string, unknown>
}

/**
 * The last N finished requests, in memory.
 *
 * The bar does **not** read the database for its own process, and that is the
 * decision this file exists for. Three things follow from it:
 *
 * - the bar works with no tables, no migration and no provider — `LENS_BAR=true`
 *   is the whole installation
 * - it works when storage is *broken*, which is exactly when somebody wants to
 *   see what the request did
 * - a development server stops writing a hundred rows per page load into the
 *   database you are inspecting
 *
 * Bounded two ways, because one is not enough. A count alone is no bound when a
 * single batch can hold a megabyte of response body, and a byte budget alone
 * would let ten thousand tiny batches accumulate. Whichever is reached first
 * evicts the oldest.
 */
export class BatchRing {
  private readonly batches: BarBatch[] = []

  /** Bytes per batch, measured once at push. */
  private readonly sizes = new Map<string, number>()

  private held = 0

  private next = 1

  constructor(
    private readonly limit: number,
    private readonly budget = 8 * 1024 * 1024,
    /**
     * The numbers the analysis argues from.
     *
     * Every one of them is a judgement, so an application that disagrees says so
     * in `lens.bar.thresholds` rather than living with ours — a hundred
     * milliseconds is a slow query in a request and an ordinary one in a report.
     */
    private readonly thresholds: Thresholds = DEFAULTS
  ) {}

  /** Adds the batch and returns the sequence it was given. */
  /**
   * Adds the batch, working out what it means on the way in.
   *
   * The caller hands over what it observed; what it *amounts to* is decided
   * here, so nothing downstream — endpoint, client, test — has to agree
   * separately about what counts as an N+1.
   */
  push(batch: Omit<BarBatch, 'seq' | 'found' | 'shape'>): number {
    const seq = this.next++
    const shape = split(batch.entries, batch.durationMs)
    const stored: BarBatch = {
      ...batch,
      seq,
      shape,
      // The batch's own facts as well as its entries: whether this was slow for
      // *this* route, where the time went before the handler, and whose code the
      // profiler caught are questions no single entry can answer.
      found: findings(batch.entries, shape, this.thresholds, batch)
    }

    this.batches.unshift(stored)
    this.sizes.set(stored.batchId, weigh(stored))
    this.held += this.sizes.get(stored.batchId) ?? 0

    this.evict()

    return seq
  }

  get(batchId: string): BarBatch | undefined {
    return this.batches.find((batch) => batch.batchId === batchId)
  }

  /** One entry by uuid, across every batch still held. */
  entry(uuid: string): BarEntry | undefined {
    for (const batch of this.batches) {
      const found = batch.entries.find((entry) => entry.uuid === uuid)

      if (found !== undefined) return found
    }

    return undefined
  }

  /** Newest first, without their entries. */
  recent(): BarSummary[] {
    return this.batches.map(summaryOf)
  }

  /**
   * Everything newer than a sequence, newest first.
   *
   * `since(0)` is the whole ring, which is what a page asks for on load.
   */
  since(seq: number): BarSummary[] {
    return this.batches.filter((batch) => batch.seq > seq).map(summaryOf)
  }

  /** The highest sequence handed out, so a client knows where it stands. */
  cursor(): number {
    return this.next - 1
  }

  /**
   * Amend entries this process has already flushed.
   *
   * A job entry is written when the job is picked up and patched when it ends,
   * and without this the bar shows every job as `pending` forever. In-process
   * only: a patch produced by a queue worker never reaches this ring, and
   * reaches the bar through storage instead.
   */
  apply(updates: EntryUpdate[]): void {
    const touched = new Set<string>()

    for (const update of updates) {
      const found = this.entry(update.uuid)

      if (found === undefined) continue

      found.content = { ...found.content, ...update.changes }
      found.summary = summarise(found.type as never, found.content)
      found.tags = [...new Set([...found.tags, ...update.tagsAdded])].filter(
        (tag) => !update.tagsRemoved.includes(tag)
      )
      touched.add(found.uuid)
    }

    /**
     * A patch can change the answer, not only a field: a job that failed a
     * moment ago is a problem the batch did not have when it closed.
     */
    for (const batch of this.batches) {
      if (!batch.entries.some((entry) => touched.has(entry.uuid))) continue

      batch.found = findings(batch.entries, batch.shape, this.thresholds, batch)
    }
  }

  clear(): void {
    this.batches.length = 0
    this.sizes.clear()
    this.held = 0
  }

  get size(): number {
    return this.batches.length
  }

  /** Bytes held, for `lens:status`. */
  get bytes(): number {
    return this.held
  }

  private evict(): void {
    while (
      this.batches.length > this.limit ||
      (this.held > this.budget && this.batches.length > 1)
    ) {
      const dropped = this.batches.pop()

      if (dropped === undefined) return

      this.held -= this.sizes.get(dropped.batchId) ?? 0
      this.sizes.delete(dropped.batchId)
    }
  }
}

/**
 * A batch's weight, measured once.
 *
 * `JSON.stringify` rather than a walk over the values: it is one pass, it counts
 * what the endpoint would actually send, and this runs after the response has
 * gone out. UTF-16 code units and not bytes, which overstates ASCII by nothing
 * and understates nothing that matters for a budget.
 */
function weigh(batch: BarBatch): number {
  try {
    return JSON.stringify(batch).length
  } catch {
    // A content value that cannot be encoded should not stop the bar working.
    return 0
  }
}

function summaryOf(batch: BarBatch): BarSummary {
  const { entries, found, profile, marks, ...rest } = batch

  return {
    ...rest,
    count: entries.length,
    source: 'ring',
    problems: found.filter((one) => one.level === 'problem').length,
    profiled: profile !== undefined
  }
}

/**
 * Flatten the entries of a batch about to be stored.
 *
 * Taken *before* the write and not from an `afterStoring` hook, deliberately:
 * that hook does not run when storage throws, and a missing table is the case
 * where the bar is most useful. The snapshot is also a copy — the batch's own
 * arrays are about to be handed to a repository.
 */
export function snapshot(entries: IncomingEntry[]): BarEntry[] {
  /**
   * Counted across the whole batch, not over neighbours.
   *
   * A loop that queries and renders between iterations still runs one statement
   * thirty times, and it is still the same mistake — folding only adjacent
   * repeats, which is what the dashboard's waterfall does for drawing, would
   * miss exactly the case worth a warning.
   */
  const families = new Map<string, number>()

  for (const entry of entries) {
    const family = entry.familyHash()

    if (family !== undefined) families.set(family, (families.get(family) ?? 0) + 1)
  }

  return entries.map((entry) => {
    const family = entry.familyHash()
    const type = String(entry.type ?? 'unknown')

    return {
      uuid: entry.uuid,
      type,
      offsetMs: Number(entry.content.offsetMs ?? 0),
      tags: [...entry.tags],
      summary: summarise(type as never, entry.content),
      repeats: family === undefined ? 1 : (families.get(family) ?? 1),
      content: entry.content
    }
  })
}

/** The list form of an entry — everything but its content. */
export function listed(entry: BarEntry): Omit<BarEntry, 'content'> {
  const { content, ...rest } = entry

  return rest
}
