import { AsyncLocalStorage } from 'node:async_hooks'
import type { RouteDefinition } from './route.ts'

/**
 * Which route is answering — Laravel's `Route::current()` and friends.
 *
 * ```ts
 * currentRouteName()              // 'photos.show'
 * currentRouteNamed('photos.*')   // true
 * current()?.uri                  // '/photos/{photo}'
 * ```
 *
 * What this is for is the thing every layout needs and nothing else can supply: a
 * navigation component deciding which link is the active one. Threading the route
 * name from the handler through every component between it and the `<nav>` is the
 * plumbing that makes people hard-code `location.pathname` instead — and a
 * component that reads the *path* breaks the moment the path changes, which is the
 * whole reason routes have names.
 *
 * `AsyncLocalStorage`, and entered from a **synchronous** hook. `enterWith`
 * applies to the remainder of the current execution; an `await` restores the frame
 * its continuation was scheduled with, so entering from an async hook is already
 * lost by the time the handler runs. `scope.ts` learned this first and says so at
 * more length.
 */
const storage = new AsyncLocalStorage<RouteDefinition>()

/** Called by the compiled router, once per request, before the handler. */
export function enterCurrentRoute(route: RouteDefinition | undefined): void {
  if (route !== undefined) storage.enterWith(route)
}

/** Run `body` with a route current. For tests, and for anything not in a hook. */
export function withCurrentRoute<T>(route: RouteDefinition, body: () => T): T {
  return storage.run(route, body)
}

/** The route answering this request, or nothing outside one. */
export function current(): RouteDefinition | undefined {
  return storage.getStore()
}

/**
 * Its name, or `undefined` when the route was never named.
 *
 * `undefined` rather than the path: a caller comparing against a name should not
 * accidentally match a path, and a route with no name has no answer to give.
 */
export function currentRouteName(): string | undefined {
  return storage.getStore()?.routeName
}

/**
 * Is the current route one of these? — `Route::currentRouteNamed`.
 *
 * `*` matches any run of characters, as Laravel's `Str::is` does, which is what
 * makes `currentRouteNamed('photos.*')` the useful form: a section of the
 * navigation is lit by a prefix rather than by listing all seven resource names.
 */
export function currentRouteNamed(...patterns: string[]): boolean {
  const name = currentRouteName()

  if (name === undefined) return false

  return patterns.some((pattern) => toExpression(pattern).test(name))
}

/** The current URI as it was written — `/photos/{photo}`. */
export function currentRouteUri(): string | undefined {
  return storage.getStore()?.uri
}

function toExpression(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

  return new RegExp(`^${escaped}$`)
}
