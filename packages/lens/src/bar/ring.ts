import type { IncomingEntry } from '../entry.ts'

/** One finished unit of work, as the bar reads it back. */
export type BarBatch = {
  batchId: string
  at: number
  method: string
  path: string
  status: number
  durationMs: number
  entries: BarEntry[]
}

/** An entry, flattened to what the bar draws. */
export type BarEntry = {
  uuid: string
  type: string
  offsetMs: number
  content: Record<string, unknown>
  tags: string[]
  /**
   * How many entries in this batch are the same thing.
   *
   * The N+1 badge, counted here rather than in the browser: the family hash is
   * already the recorder's answer to "is this the same query", the count is
   * worth a test, and a test in Bun is worth more than one in a page.
   */
  repeats: number
}

/**
 * The last N finished requests, in memory.
 *
 * The bar does **not** read the database, and that is the decision this file
 * exists for. Three things follow from it, all of which matter more than the
 * duplication costs:
 *
 * - the bar works with no tables, no migration and no provider — `LENS_BAR=true`
 *   is the whole installation
 * - it works when storage is *broken*, which is exactly when somebody wants to
 *   see what the request did
 * - a development server stops writing a hundred rows per page load into the
 *   database you are inspecting
 *
 * Bounded by construction. A ring and not a growing list because this is held
 * for the life of the process, and a developer leaves `bun elvel dev` running
 * for days.
 */
export class BatchRing {
  private readonly batches: BarBatch[] = []

  constructor(private readonly limit: number) {}

  push(batch: BarBatch): void {
    this.batches.unshift(batch)

    if (this.batches.length > this.limit) this.batches.length = this.limit
  }

  get(batchId: string): BarBatch | undefined {
    return this.batches.find((batch) => batch.batchId === batchId)
  }

  /**
   * Newest first, without their entries.
   *
   * The bar shows a list of recent requests and the details of one. Sending
   * every entry of all twenty would be most of a megabyte on a page that has
   * not been clicked yet.
   */
  recent(): Array<Omit<BarBatch, 'entries'> & { count: number }> {
    return this.batches.map(({ entries, ...rest }) => ({ ...rest, count: entries.length }))
  }

  clear(): void {
    this.batches.length = 0
  }

  get size(): number {
    return this.batches.length
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

    return {
      uuid: entry.uuid,
      type: String(entry.type ?? 'unknown'),
      offsetMs: Number(entry.content.offsetMs ?? 0),
      content: entry.content,
      tags: [...entry.tags],
      repeats: family === undefined ? 1 : (families.get(family) ?? 1)
    }
  })
}
