import { describe, test } from 'bun:test'
import { test as press } from '@elvel/testing'
import app from '../../bootstrap/app.ts'

/**
 * A feature test: the whole application, without a socket.
 *
 * `press(app)` runs a request through the same `handle()` a server would —
 * middleware, the session, validation, the exception handler and all — so what
 * passes here is what a browser would have got. There is no server to start and
 * no port to pick.
 *
 * This kit's version asserts what its two view routes do, which the template's
 * could not: the root is not a page here, it is the guarded wildcard, and a guest
 * asking for it is sent to sign in rather than shown anything.
 *
 * `tests/Feature` for tests that boot the application, `tests/Unit` for the ones
 * that do not — Laravel's split, and worth keeping: the two have very different
 * costs, and being able to run the fast ones alone is the difference between a
 * suite you run on every save and one you run before pushing.
 */
describe('the view routes', () => {
  /**
   * The landing page is server rendered, and it is the one page that is.
   *
   * An exact route beats the view wildcard, so `routes/web.ts` answers `/` with
   * markup rather than the shell — a visitor sees something before a bundle
   * arrives. Everything else a browser can type goes to `routes/view.ts`.
   */
  test('the root is a rendered page, open to anybody', async () => {
    const response = await press(app).get('/')

    response
      .assertOk()
      .assertHeaderContains('content-type', 'text/html')
      // Markup, not the mount point the client boots from.
      .assertDontSee('data-spa-root')
      .assertSee('/auth/sign-in')
  })

  test('and the sign-in screen is a document with nothing in it', async () => {
    const response = await press(app).get('/auth/sign-in')

    response
      .assertOk()
      .assertHeaderContains('content-type', 'text/html')
      .assertSee('<!DOCTYPE html>')
      // A shell: no payload, so the same bytes go to everybody.
      .assertSee('data-spa-root')
  })

  test('every guest address under the prefix answers the same document', async () => {
    // No list on the server: `frontend/src/routers/auth.ts` is what knows these.
    for (const path of ['/auth/sign-up', '/auth/forgot-password', '/auth/two-factor-challenge']) {
      ;(await press(app).get(path)).assertOk().assertSee('data-spa-root')
    }
  })
})

describe('what answers for itself', () => {
  /**
   * `/health` is not a page, and must not become one.
   *
   * A load balancer asking wants a status code, not JavaScript — and it has to
   * answer before any bundle is built. Exact routes win over the wildcards, which
   * is the measurement the whole shape rests on.
   */
  test('/health, with no session at all', async () => {
    ;(await press(app).get('/health')).assertOk()
  })

  test('and the session endpoint, which a guest needs most', async () => {
    const response = await press(app).getJson('/api/session')

    // Unguarded on purpose: the shell carries no CSRF token, so the sign-in form
    // has nothing to post without this.
    response.assertOk().assertJsonPath('user', null)
  })
})

/**
 * What the view route must **not** answer, once somebody is signed in.
 *
 * This is where a single wildcard goes wrong, and only for the half of the traffic
 * that is past the guard — as a guest everything below is a redirect, so a test
 * that never signs in would pass while the application was broken. Both of these
 * were measured answering `200` and a page of HTML:
 *
 * - `GET /api/nothing` — a mistyped endpoint, reaching a `fetch` as a parse error
 *   three layers from the mistake.
 * - `GET /build/assets/index-abc123.js` — a stale asset from a cached document,
 *   so a browser waiting for JavaScript is handed a page instead.
 *
 * `routes/api.ts` and `routes/view.ts` each carry one route that claims those
 * prefixes back. A 404 handler cannot do it: a route that matches means there is
 * no 404 to speak about.
 */
describe('what stays a 404 for somebody signed in', () => {
  const address = () => `a-${Math.random().toString(36).slice(2)}@example.com`

  /** A registered session, since a guest is redirected before any of this. */
  const signedIn = async () => {
    const session = await press(app).get('/api/session')
    const token = (session.json() as { csrf: string }).csrf

    return press(app).withCookiesFrom(session).postJson('/api/sign-up', {
      _token: token,
      name: 'Ada',
      email: address(),
      password: 'longenough1'
    })
  }

  test('a missing endpoint under /api/, on any verb', async () => {
    const me = await signedIn()

    ;(await press(app).withCookiesFrom(me).getJson('/api/nothing')).assertNotFound()

    /**
     * The write carries a token, because every write here does.
     *
     * `config/session.ts` exempts only better-auth's own mount from CSRF, so a
     * tokenless `POST /api/nothing` is refused with `419` before any route is
     * consulted — a true answer to a different question. The token turns this back
     * into the one being asked: does a missing endpoint stay a 404.
     */
    const session = await press(app).withCookiesFrom(me).get('/api/session')
    const token = (session.json() as { csrf: string }).csrf
    const posted = await press(app)
      .withCookiesFrom(me)
      .withCookiesFrom(session)
      .postJson('/api/nothing', { _token: token })

    posted.assertNotFound()
  })

  /**
   * The signed-in shell is `private`, and the guest one is `public`.
   *
   * Both carry the same impersonal bytes; what differs is that this one only exists
   * for somebody with a cookie — a guest gets a 302. A shared cache serving it
   * while it revalidated would be answering for the guard, so the guarded half says
   * `private` and the guest half does not.
   */
  test('and the shell it does answer says who may cache it', async () => {
    const me = await signedIn()
    const mine = await press(app).withCookiesFrom(me).get('/invoices/9')

    mine.assertOk().assertHeaderContains('cache-control', 'private')

    const theirs = await press(app).get('/auth/sign-in')

    theirs.assertOk().assertHeaderContains('cache-control', 'public')
  })

  test('and a file the build does not have', async () => {
    const me = await signedIn()
    const response = await press(app).withCookiesFrom(me).get('/build/assets/index-abc123.js')

    response.assertNotFound()
  })

  test('while the endpoints and files that exist still answer', async () => {
    const me = await signedIn()

    ;(await press(app).withCookiesFrom(me).getJson('/api/settings/profile')).assertOk()

    // The document route still owns every address a person could type.
    ;(await press(app).withCookiesFrom(me).get('/invoices/9')).assertOk().assertSee('data-spa-root')
  })
})
