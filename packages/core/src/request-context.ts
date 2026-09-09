import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * One `AsyncLocalStorage` for everything that belongs to a request.
 *
 * There were five: the request scope, the cookie bag, the current route, the
 * auth session and the deferred queue, each with its own storage and each
 * calling `enterWith` once per request. A CPU profile of a scaffolded `api`
 * application under load — a route returning `{ ok: true }`, reading nothing —
 * put `enterWith` and the native `concat` underneath it at **11% of all
 * samples**, 374 of 377 `concat` samples coming from there. That is the cost of
 * entering a context, five times, to carry five things.
 *
 * So there is one context and five slots in it. The first writer of a request
 * creates it and enters it; everybody after that assigns a property, which costs
 * nothing. Verified against Elysia's hook chain before any of this was written:
 * an `enterWith` in `onRequest` is visible in `onTransform`, in
 * `onBeforeHandle`, in the handler, and **through an `await` inside an async
 * hook** — and mutations made along the way are visible to everything after.
 *
 * Order does not matter, which is the point: whichever hook writes first does
 * the entering. That also means the error path — an exception handler entering a
 * scope for a request that never reached a hook — needs no special case.
 *
 * `enterWith` still **must** be called from a synchronous hook to reach the
 * handler; that constraint has not changed, and it is now paid once instead of
 * five times.
 */

/** The store: slots keyed by the symbols {@link requestSlot} hands out. */
type Context = Record<symbol, unknown>

const storage = new AsyncLocalStorage<Context>()

/**
 * Marks a context as belonging to a request, so the next one does not inherit it.
 *
 * The distinction this draws is the whole of it: a context something *outside* a
 * request established — `AuthManager.runWith` setting a session before calling
 * the application — must carry forward, and a context the *previous request*
 * left behind must not.
 */
const REQUEST = Symbol('elvel.request')

/**
 * The context that surrounded the request, kept so the next one can inherit it
 * again.
 *
 * Marking alone was not enough. Once request one had opened a marked context,
 * request two saw only *that* — so refusing to inherit a marked context also
 * threw away the `runWith` session sitting outside both of them, and a test
 * making two requests as a signed-in user had the second answer as a guest. The
 * outside travels with the mark.
 */
const OUTSIDE = Symbol('elvel.outside')

/**
 * One typed slot in the request context.
 *
 * Each package declares its own and keeps its own types — `@elvel/core` never
 * learns what a `CookieBag` or a `RouteDefinition` is, and no call site casts.
 */
export type RequestSlot<T> = {
  /** Its value for this request, or nothing outside one. */
  get(): T | undefined

  /**
   * Set it for the rest of this request.
   *
   * Enters the context if this is the first slot written, which is why it must
   * be reached from a **synchronous** hook the first time — see above.
   */
  set(value: T): void

  /** Run `body` with this slot set, leaving the surrounding context in place. */
  run<R>(value: T, body: () => R): R
}

/**
 * Declare a slot.
 *
 * ```ts
 * const cookies = requestSlot<CookieBag>('cookies')
 * cookies.set(bag)      // from a synchronous hook
 * cookies.get()         // anywhere in the request
 * ```
 *
 * The name is for debugging only; the symbol is the identity, so two packages
 * declaring the same name get two different slots rather than one they fight
 * over.
 */
export function requestSlot<T>(name: string): RequestSlot<T> {
  const key = Symbol(name)

  return {
    get(): T | undefined {
      return storage.getStore()?.[key] as T | undefined
    },

    /**
     * On the request path this only ever mutates: `enterRequestContext` has
     * already run. The fallback is for everything else — a console command, a
     * queue worker, a test — where there is no hook to have opened one.
     */
    set(value: T): void {
      const store = storage.getStore()

      if (store === undefined) {
        storage.enterWith({ [key]: value })
        return
      }

      store[key] = value
    },

    /**
     * Merged onto the surrounding context rather than replacing it.
     *
     * With five separate storages, each `with…` helper isolated one thing
     * because it could not see the others. With one, replacing the store would
     * mean a test that sets a cookie bag inside a request scope silently loses
     * the scope — so the outer context survives and only this slot changes.
     */
    run<R>(value: T, body: () => R): R {
      return storage.run({ ...storage.getStore(), [key]: value }, body)
    }
  }
}

/**
 * Open a fresh context for this request, before anything writes to it.
 *
 * The http layer calls this from the **first** synchronous `onRequest` hook, and
 * that is what makes the slots below safe: every one of them then finds a context
 * that belongs to this request and mutates it, and none of them has to decide
 * whether to enter one.
 *
 * Without it the first slot written would enter the context — which works, but
 * only because `enterWith` in Elysia's `onRequest` lands in a frame of the
 * request's own. Verified that it does; declined to depend on it. A caller that
 * writes a slot synchronously from a frame it *shares* with another request
 * would otherwise mutate that request's context, and a session read by the wrong
 * visitor is not a bug worth risking to save one call.
 *
 * A **fresh object**, always — so a slot written during the request cannot escape
 * to whatever surrounds it, and two requests never share one.
 *
 * What it inherits is the part that took two attempts. Inheriting everything was
 * the first answer, because something outside deliberately establishes a context
 * in the case that matters most: `AuthManager.runWith` is how a test acts as a
 * signed-in user, and it sets the session and *then* calls the application.
 * Entering an empty object threw that away and every guarded route in the suite
 * answered as a guest.
 *
 * But `enterWith` inside `app.handle()` reaches the **caller's** frame, so two
 * requests driven from one frame had the second inherit the first's slots — its
 * session, its cookie jar, its signed-in user. A served request is unaffected,
 * each arriving in a frame of its own; a test making two requests is not, and
 * `test(app)` is `app.handle()`. Found by a Telescope-shaped spike whose
 * per-request batch the second request inherited, already completed, and wrote
 * nothing into.
 *
 * So a context is marked when a request opens it, and what a request inherits is
 * the **unmarked** context outside it — carried along on the mark, because after
 * the first request the thing immediately surrounding the second is the first.
 * `runWith` sets a slot without opening a context, so its work reaches every
 * request; a request's own work reaches none.
 */
export function enterRequestContext(): void {
  const surrounding = storage.getStore()

  const outside =
    surrounding === undefined
      ? undefined
      : surrounding[REQUEST] === true
        ? (surrounding[OUTSIDE] as Context | undefined)
        : surrounding

  storage.enterWith({ ...outside, [REQUEST]: true, [OUTSIDE]: outside })
}

/** Whether anything has entered a request context here. For tests and guards. */
export function inRequestContext(): boolean {
  return storage.getStore() !== undefined
}

/**
 * Run `body` in a context of its own, with nothing inherited.
 *
 * The one place isolation is still wanted: a test asserting that a helper reads
 * as absent outside a request, and a worker that must not see the context of
 * whatever enqueued its job.
 */
export function withoutRequestContext<T>(body: () => T): T {
  return storage.run({}, body)
}
