import { inRequestContext, requestSlot } from '@elvel/core'

/** Every shared value computed so far in this request. */
const slot = requestSlot<Map<symbol, unknown>>('view.shared')

/**
 * Data a layout needs on every page, without threading it through every handler.
 *
 * The framework already works this way — `errors()`, `old()`, `stack()`,
 * `csrfField()` and `cspNonce()` are all read from the request scope inside a
 * component rather than passed as props — and an application had no way to
 * register one of its own. So the unread count, the current tenant, the feature
 * flags and the navigation were threaded through the props of every handler that
 * rendered that layout, and adding one meant editing all of them.
 *
 * Not upstream's untyped `share()`: this is a value with a type, declared once
 * and imported where it is read, so a component that reads it is checked.
 *
 * ```ts
 * // app/view/shared.ts
 * export const unread = shared(async () => currentUser()?.unreadCount() ?? 0)
 *
 * // in a layout
 * <span>{await unread()}</span>
 * ```
 *
 * Computed on first read and remembered for the rest of the request, so a page
 * that never reads it never pays for it and a page that reads it four times pays
 * once. Outside a request — a mail rendered from a worker, a page rendered in a
 * command — there is nothing to remember it in, so it is computed per call.
 */
export function shared<T>(compute: () => T): () => T {
  const key = Symbol('view.shared')

  return (): T => {
    if (!inRequestContext()) return compute()

    let held = slot.get()

    if (held === undefined) {
      held = new Map<symbol, unknown>()
      slot.set(held)
    }

    if (held.has(key)) return held.get(key) as T

    const value = compute()
    held.set(key, value)

    return value
  }
}

/**
 * The same, for a value the request establishes rather than computes.
 *
 * A middleware sets it and every component reads it — the current tenant
 * resolved from the host, the theme read from a cookie. Reading before anything
 * set it answers with the default rather than throwing, because a component
 * rendered outside a request is a legitimate thing to do.
 */
export function sharedValue<T>(fallback: T): {
  (): T
  set(value: T): void
} {
  const key = Symbol('view.shared-value')

  const read = (): T => {
    const held = slot.get()

    return held?.has(key) === true ? (held.get(key) as T) : fallback
  }

  read.set = (value: T): void => {
    let held = slot.get()

    if (held === undefined) {
      held = new Map<symbol, unknown>()
      slot.set(held)
    }

    held.set(key, value)
  }

  return read
}
