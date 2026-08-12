/** A callback deferred until after the response has been sent. */
type Deferred = { key?: string; callback: () => unknown; always: boolean }

const pending: Deferred[] = []

/**
 * Run `callback` after the response has been sent — Laravel's `defer()`.
 *
 * The request pays for nothing but the queueing. It is the right tool for work
 * that is too small to queue and too slow to make a client wait: refreshing a
 * stale cache entry, writing an audit line, warming something up.
 *
 * A `key` makes it idempotent within one request: deferring the same key twice
 * runs it once, which is what stops a loop from scheduling a hundred refreshes of
 * the same value.
 *
 * ```ts
 * defer(() => warmCaches(), { key: 'warm' })
 * ```
 *
 * Nothing here is durable. A process that dies before the flush loses the work,
 * which is precisely the line between `defer()` and a queued job.
 */
export function defer(
  callback: () => unknown,
  options: { key?: string; always?: boolean } = {}
): void {
  if (options.key !== undefined && pending.some((entry) => entry.key === options.key)) return

  pending.push({ key: options.key, callback, always: options.always ?? false })
}

/**
 * Run everything deferred so far.
 *
 * Called by the http layer once the response is out, and by the console kernel
 * when a command finishes. Failures are swallowed on purpose: deferred work runs
 * with nobody left to answer to, and one bad callback must not stop the rest.
 */
export async function flushDeferred(
  report: (error: unknown) => void = () => undefined
): Promise<number> {
  const entries = pending.splice(0, pending.length)

  for (const entry of entries) {
    try {
      await entry.callback()
    } catch (error) {
      report(error)
    }
  }

  return entries.length
}

/** Throw away what has been deferred without running it. */
export function forgetDeferred(): number {
  return pending.splice(0, pending.length).length
}

/** How many callbacks are waiting. For tests and diagnostics. */
export function deferredCount(): number {
  return pending.length
}
