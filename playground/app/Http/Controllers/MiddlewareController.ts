import { user } from '@elysian/auth'
import { controller } from '@elysian/core'
import { middleware, routes, signedRoute, signedUrl } from '@elysian/http'

/**
 * Named so `signedRoute()` has something to sign.
 *
 * A signature covers the URL, so the URL has to be built from a name rather than
 * typed twice — and `verify()` refuses to boot if the name and the path drift.
 */
routes().names({
  'middleware.unsubscribe': '/check/middleware/unsubscribe'
})

/**
 * Generated with `bun run playground make:controller MiddlewareController`, then
 * extended.
 *
 * Route middleware, said on the route rather than checked inside the handler.
 * Every handler here is one line, because the condition is not its business:
 *
 * ```ts
 * .get('/private', handler, middleware('auth'))
 * .get('/mine', handler, middleware('auth', 'verified', 'can:view-status-page'))
 * ```
 *
 * The contrast worth pressing is `/check/middleware/private` against
 * `/check/middleware/api`. Both carry `middleware('auth')` and nothing else, and
 * the same guest gets a **302 to `/sign-in`** from one and a **401 with no
 * `Location`** from the other — because the second asks for JSON. A client that
 * follows redirects would otherwise report the sign-in page as a successful
 * answer to its request, which is the bug the split exists to prevent.
 *
 * Sign in through better-auth's own endpoints first:
 *
 *   POST /api/auth/sign-up/email  {"name","email","password"}
 *   POST /api/auth/sign-in/email  {"email","password"}
 */
export default controller('middleware-demo')
  /** No middleware at all, for comparison. */
  .get('/check/middleware/open', () => ({ open: true }))

  /** A page: a guest is redirected and where they were going is remembered. */
  .get('/check/middleware/private', () => ({ email: user()?.email ?? null }), middleware('auth'))

  /**
   * The same middleware, answered as JSON.
   *
   * `accept: application/json` on the request is what flips it; there is no
   * second alias and no option — the middleware reads the request.
   */
  .get('/check/middleware/api', () => ({ email: user()?.email ?? null }), middleware('auth'))

  /** The inverse: signed in is what gets turned away here. */
  .get('/check/middleware/guest-only', () => ({ guest: true }), middleware('guest'))

  /** A confirmed address, which a guest also fails — deliberately. */
  .get('/check/middleware/verified', () => ({ verified: true }), middleware('verified'))

  /**
   * Written in the wrong order on purpose.
   *
   * `verified` reads the user `auth` guarantees, so the registry's priority list
   * runs `auth` first anyway. A guest therefore lands on `/sign-in` rather than
   * being told their email is unverified.
   */
  .get('/check/middleware/ordered', () => ({ both: true }), middleware('verified', 'auth'))

  /**
   * The Gate, reached from the route rather than from inside the handler.
   *
   * `access-admin` rather than `view-status-page`: the latter is defined with
   * `allowGuests` and returns true, so it would answer 200 to everybody and prove
   * nothing about the middleware.
   */
  .get('/check/middleware/gated', () => ({ allowed: true }), middleware('can:access-admin'))

  /** Three a minute, then 429 with `Retry-After`. */
  .get('/check/middleware/limited', () => ({ ok: true }), middleware('throttle:3,1'))

  /**
   * Mint a signed link, then follow it.
   *
   * The signature covers the path and every parameter, so editing `?list=` in the
   * address bar turns a 200 into a 403 — which is the point of handing a link to
   * somebody who has no session.
   */
  .get('/check/middleware/sign', ({ query }) => {
    const list = query.list ?? '7'

    return {
      url: signedRoute('middleware.unsubscribe', { list }),
      expiring: signedRoute('middleware.unsubscribe', { list }, 60),
      // Path and query only, so it survives being followed on another host.
      relative: signedUrl(`/check/middleware/unsubscribe-relative?list=${list}`, undefined, false)
    }
  })

  .get(
    '/check/middleware/unsubscribe',
    ({ query }) => ({ unsubscribed: query.list ?? null }),
    middleware('signed')
  )

  /**
   * The same check, over the path and query only.
   *
   * `signed` covers the origin too, which is right for a link in an email and
   * wrong behind a proxy that rewrites the host — or on any port other than the
   * one `APP_URL` names, which is what makes the absolute form untestable on an
   * ephemeral port. `signed:relative` is the escape hatch, and the cost is that a
   * signature minted for one hostname is valid on another.
   */
  .get(
    '/check/middleware/unsubscribe-relative',
    ({ query }) => ({ unsubscribed: query.list ?? null, relative: true }),
    middleware('signed:relative')
  )

  /**
   * A whole group behind one declaration — Laravel's `Route::middleware(...)
   * ->group(...)`.
   *
   * `guard()` takes the same object `middleware()` returns, so a group and a
   * route are written the same way.
   */
  .guard(middleware('auth'), (routes) =>
    routes
      .get('/check/middleware/group/one', () => ({ one: true }))
      .get('/check/middleware/group/two', () => ({ two: true }))
  )
