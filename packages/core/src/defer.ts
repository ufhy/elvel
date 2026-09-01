import { requestSlot } from './request-context.ts'

/** A callback deferred until after the response has been sent. */
type Deferred = { key?: string; callback: () => unknown; always: boolean }

/** A queue of deferred callbacks — one per request, or the process-wide one. */
export type DeferredQueue = Deferred[]

/**
 * The queue belonging to the work in flight, when something opened one.
 *
 * Without this the queue was a single module-level array shared by every request,
 * and two things went wrong with it. A request that finished first flushed
 * **another request's** callbacks — measured: request B's flush ran A's callback
 * and A's own flush then found nothing, so A's deferred work ran before A had
 * finished, reported through B's exception handler. And `key` deduplicated across
 * requests, so two callers deferring `{ key: 'refresh' }` at the same moment ran
 * it once and one of them silently lost its work.
 *
 * A slot in the one request context rather than a storage of its own, for the
 * reason `request-context.ts` gives: entering a context costs, and this used to
 * be the fifth thing paying for it separately. It is still set from a
 * synchronous hook, because the queue has to be visible to everything the
 * handler awaits.
 */
const slot = requestSlot<DeferredQueue>('deferred')

/** What a caller outside any request defers into — a console command, or boot. */
const pending: DeferredQueue = []

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
  const queue = slot.get() ?? pending

  if (options.key !== undefined && queue.some((entry) => entry.key === options.key)) return

  queue.push({ key: options.key, callback, always: options.always ?? false })
}

/**
 * Open a queue for one unit of work, so its callbacks are its own.
 *
 * Must be called from a **synchronous** hook: `enterWith` applies to the rest of
 * the current execution, and an `await` before it would leave the handler deferring
 * into the process-wide queue.
 */
export function enterDeferredScope(queue: DeferredQueue = []): DeferredQueue {
  slot.set(queue)

  return queue
}

/**
 * Run everything deferred so far.
 *
 * Called by the http layer once the response is out, and by the console kernel
 * when a command finishes. Failures are swallowed on purpose: deferred work runs
 * with nobody left to answer to, and one bad callback must not stop the rest.
 */
export async function flushDeferred(
  report: (error: unknown) => void = () => undefined,
  queue: DeferredQueue = slot.get() ?? pending
): Promise<number> {
  const entries = queue.splice(0, queue.length)

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
export function forgetDeferred(queue: DeferredQueue = slot.get() ?? pending): number {
  return queue.splice(0, queue.length).length
}

/** How many callbacks are waiting. For tests and diagnostics. */
export function deferredCount(queue: DeferredQueue = slot.get() ?? pending): number {
  return queue.length
}
