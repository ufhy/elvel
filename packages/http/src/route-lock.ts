import { app, HttpException, requestSlot } from '@elvel/core'

/** Enough of the cache for a route lock; `@elvel/cache` satisfies it. */
type Held = { release(): Promise<boolean> }

type Locks = {
  lock(
    name: string,
    seconds?: number,
    owner?: string
  ): Held & { block(waitFor: number): Promise<unknown> }
}

type Context = { request: Request }

/**
 * The lock this request is holding, so the hook after the handler can release
 * it. A slot rather than a map keyed on the request: the request object is not
 * the identity Elysia carries through its hooks, and the context is.
 */
const held = requestSlot<Held>('route-lock')

/** Thrown when the wait ran out. A `429`, so a client knows to try again. */
export class RouteBusyError extends HttpException {
  constructor(seconds: number) {
    super(429, `Another request for this route is still running. Waited ${seconds}s.`)
    this.name = 'RouteBusyError'
  }
}

export type RouteLockOptions = {
  /** How long the lock is held if the handler never releases it. */
  hold?: number
  /** How long a second caller waits before giving up. */
  wait?: number
  /** What the lock is keyed on, beyond the route and the user. */
  key?: (request: Request) => string
}

/**
 * One request at a time, per route and per caller.
 *
 * The one-line answer to a double-submitted form, a double-clicked "Pay"
 * button, and a mobile client retrying a request whose response it never
 * received — all of which arrive as two requests that each believe they are the
 * only one.
 *
 * Keyed on the authenticated user as well as the route, because two different
 * people paying at once is not the problem: the same person paying twice is.
 * An anonymous caller falls back to the client address, which is the closest
 * thing to an identity there is.
 *
 * `hold` and `wait` are separate on purpose. The hold is how long the lock
 * survives a handler that died without releasing it; the wait is how long the
 * second caller is willing to queue. One number for both would make a slow
 * handler either unprotected or a hang.
 */
export function routeLock(options: RouteLockOptions = {}) {
  const hold = options.hold ?? 10
  const wait = options.wait ?? 10

  return async (context: Context): Promise<Response | undefined> => {
    const container = app()

    if (!container.bound('cache')) {
      throw new Error(
        'A route lock needs the cache. Register CacheServiceProvider, or drop the middleware.'
      )
    }

    const cache = container.make('cache') as unknown as Locks
    const name = `elvel:route-lock:${options.key ? options.key(context.request) : identity(context.request)}`

    const lock = cache.lock(name, hold)

    try {
      /**
       * Taken here and released after the handler, not around a callback.
       *
       * Elysia has no way to wrap a handler, so `block(wait, callback)` would
       * have to release before the handler ran — which is a check, not a lock:
       * the second request would get in while the first was still writing. The
       * hold is what covers the gap if the release never happens.
       */
      await lock.block(wait)
    } catch {
      throw new RouteBusyError(wait)
    }

    held.set(lock)

    return undefined
  }
}

/**
 * Release whatever this request took.
 *
 * Registered by the http provider as an `onAfterResponse` hook, so it runs after
 * a thrown handler as surely as after a returned one — a lock a failed request
 * kept would block the retry that failure invites.
 */
export async function releaseRouteLock(): Promise<void> {
  const lock = held.get()

  if (lock === undefined) return

  await lock.release().catch(() => undefined)
}

/**
 * Route, plus whoever is asking.
 *
 * The path and not the route name: a name is optional and a lock that silently
 * covered every unnamed route together would serialise an entire application.
 */
function identity(request: Request): string {
  const url = new URL(request.url)
  const who = currentUserId() ?? request.headers.get('x-forwarded-for') ?? 'guest'

  return `${request.method}:${url.pathname}:${who}`
}

/** The signed-in user, when the auth package is registered. */
function currentUserId(): string | undefined {
  const container = app()

  if (!container.bound('auth')) return undefined

  const manager = container.make('auth') as { user?(): { id?: unknown } | null }
  const id = manager.user?.()?.id

  return id === undefined || id === null ? undefined : String(id)
}
