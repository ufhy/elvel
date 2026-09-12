/**
 * What a route usually costs, learned while the server runs.
 *
 * The one thing no PHP debug bar can do, and not for want of trying: PHP-FPM
 * forgets everything between requests, so a Debugbar can tell you this page took
 * 400ms but never that the same page takes 40ms the rest of the time. A Bun
 * server is one long-lived process, so it can simply remember.
 *
 * Kept per *route pattern* rather than per path — `/articles/:id` is one thing
 * whose cost is worth knowing, and a thousand ids would be a thousand samples of
 * one each. Falls back to the path when no route matched, which is what a 404
 * is.
 */
export type Cost = {
  route: string
  samples: number
  medianMs: number
  slowestMs: number
}

/** How this request compares to the ones before it. */
export type Verdict = {
  route: string
  samples: number
  medianMs: number
  /** How many times the median this request took. Absent until there is a median. */
  times?: number
}

export class Baselines {
  private readonly seen = new Map<string, number[]>()

  /**
   * The last N durations per route, and N is small on purpose.
   *
   * A median over the last fifty is what a developer means by "usually" while
   * they are working — it follows the code they are editing instead of averaging
   * over a change they made an hour ago.
   */
  constructor(private readonly window = 50) {}

  /** Record this request and say how it compares to the ones before it. */
  record(route: string, durationMs: number): Verdict {
    const held = this.seen.get(route) ?? []
    const before = held.length === 0 ? undefined : median(held)

    held.push(durationMs)

    if (held.length > this.window) held.shift()

    this.seen.set(route, held)

    return {
      route,
      samples: held.length,
      medianMs: round(median(held)),
      /**
       * Measured against the median *before* this request, so a slow one is not
       * partly compared against itself. Meaningless under a few samples, and the
       * client is told the count so it can decline to draw a conclusion.
       */
      times:
        before === undefined || before <= 0 ? undefined : round(durationMs / Math.max(before, 1))
    }
  }

  /** Every route seen, slowest first — the answer to "what is heavy here". */
  costs(): Cost[] {
    return [...this.seen.entries()]
      .map(([route, held]) => ({
        route,
        samples: held.length,
        medianMs: round(median(held)),
        slowestMs: round(Math.max(...held))
      }))
      .sort((a, b) => b.medianMs - a.medianMs)
  }

  clear(): void {
    this.seen.clear()
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length === 0) return 0
  if (sorted.length % 2 === 1) return sorted[middle] as number

  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
