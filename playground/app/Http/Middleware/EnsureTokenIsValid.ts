import { ForbiddenException } from '@elysian/core'
import type { MiddlewareHook } from '@elysian/http'

/**
 * Generated with `bun run playground make:middleware EnsureTokenIsValid`, then
 * filled in.
 *
 * A middleware the *application* writes, as opposed to the aliases the framework
 * ships. Laravel's documentation uses this same example, and it is the useful one
 * because it takes a parameter:
 *
 * ```ts
 * // app/Providers/AppServiceProvider.ts
 * middlewares().alias('token', (expected = 'let-me-in') => ensureTokenIsValid(expected))
 *
 * // a route
 * .get('/secret', handler, middleware('token:let-me-in'))
 * ```
 *
 * Everything after the first colon is the parameters, split on commas, so
 * `token:let-me-in` arrives here as `'let-me-in'`.
 *
 * Returning nothing lets the request through. This one **throws** instead of
 * returning a response, because `ForbiddenException` is already rendered as a 403
 * for a page and as JSON for an API caller — a middleware that built its own
 * `Response` would have to decide that itself, and get it wrong for one of them.
 */
export function ensureTokenIsValid(expected: string): MiddlewareHook {
  return (context) => {
    const { request } = context
    const url = new URL(request.url)

    // Either a header or a query parameter, so it can be tried from a browser
    // address bar as well as from curl.
    const provided = request.headers.get('x-demo-token') ?? url.searchParams.get('token')

    if (provided === expected) return undefined

    throw new ForbiddenException(
      provided === null
        ? 'This route needs a token. Add ?token=… or an x-demo-token header.'
        : 'That token is not the one this route wants.'
    )
  }
}
