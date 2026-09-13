/**
 * The time the framework reads, so a test can move it.
 *
 * Anything with a deadline in it — a lock that polls, a rate-limit window, a
 * cache TTL, a scheduled frequency — has to read the clock from one place, or a
 * test of it can only be written by waiting. Six such places had hand-rolled an
 * injectable clock of their own before this existed.
 *
 * `Date.now()` stays correct everywhere else; this is for framework code that a
 * test needs to move past.
 */

/** Milliseconds added to the real clock, or a fixed instant when frozen. */
let offset = 0
let frozen: number | undefined

export const Clock = {
  /** Milliseconds since the epoch, as the framework sees them. */
  now(): number {
    return frozen ?? Date.now() + offset
  },

  date(): Date {
    return new Date(Clock.now())
  },

  /** Stop the clock. Without an argument, at this instant. */
  freeze(at?: Date | number): void {
    frozen = at === undefined ? Clock.now() : at instanceof Date ? at.getTime() : at
  },

  /** Move by a number of milliseconds. Works frozen or running. */
  advance(milliseconds: number): void {
    if (frozen !== undefined) frozen += milliseconds
    else offset += milliseconds
  },

  /** Jump to a moment. */
  travelTo(when: Date | number): void {
    const at = when instanceof Date ? when.getTime() : when

    if (frozen !== undefined) frozen = at
    else offset = at - Date.now()
  },

  /** Real time again. */
  restore(): void {
    offset = 0
    frozen = undefined
  },

  isFrozen(): boolean {
    return frozen !== undefined
  },

  /** Run `callback` at a moment, then put the clock back. */
  at<T>(when: Date | number, callback: () => T): T {
    const previousOffset = offset
    const previousFrozen = frozen

    Clock.freeze(when)

    try {
      return callback()
    } finally {
      offset = previousOffset
      frozen = previousFrozen
    }
  }
}
