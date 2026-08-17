import { beforeEach, describe, test } from 'bun:test'
import { test as press, type TestResponse } from '@elyvel/testing'
import app from '../../../bootstrap/app.ts'
import '../../../tests/database.ts'

/**
 * The kit's own flows, as tests you own.
 *
 * These are yours to change: they came with the kit so that the pages it ships
 * are covered from the first day, and so there is a worked example of the two
 * things every test of an authenticated application has to do — carry cookies
 * between requests, and send the CSRF token that the form carried.
 *
 * `press(app)` runs a request through the same `handle()` a server would, so
 * the session, the middleware and the exception handler all take part. There is
 * no server to start.
 */

/**
 * The rate limiter, cleared between tests.
 *
 * `/sign-in` and `/sign-up` are throttled — six a minute, so they are not a
 * credential-stuffing endpoint — and the counts live in the store named by
 * `cache.limiter`, which is an array store and therefore per process. Six
 * registrations into a run, the seventh is a 429 and the test that made it
 * fails for a reason that has nothing to do with what it was checking.
 *
 * Clearing it here says the same thing every test in this file means: this is
 * not the test about throttling.
 */
beforeEach(async () => {
  await app.make('cache').store('array').flush()
})

/** The hidden CSRF field, as the form renders it. */
function tokenIn(html: string): string {
  const found = /name="_token" value="([^"]+)"/.exec(html)?.[1]

  if (!found) throw new Error('No CSRF token on the page. Is SESSION_CSRF off?')

  return found
}

/** A unique address per run, so a re-run is not a duplicate registration. */
const address = () => `test-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`

/**
 * Register, and answer with the response that carries the session cookie.
 *
 * The page is fetched first for its token and its cookie: a session that has
 * never been written to has no token to check against, and posting without one
 * is a 419 rather than a failure of whatever was being tested.
 */
async function register(email: string, password = 'longenough1'): Promise<TestResponse> {
  const page = await press(app).get('/sign-up')

  return await press(app)
    .withCookiesFrom(page)
    .form('POST', '/sign-up', {
      _token: tokenIn(page.body),
      name: 'Test Person',
      email,
      password
    })
}

describe('registration', () => {
  test('creates an account and signs it in', async () => {
    const registered = await register(address())

    registered.assertRedirect('/dashboard')

    const dashboard = await press(app).withCookiesFrom(registered).get('/dashboard')

    dashboard.assertOk().assertSee('Test Person')
  })

  test('refuses an address that is already taken', async () => {
    const email = address()
    await register(email)

    const again = await register(email)

    // Back to the form with an error, not a 500 and not a second account.
    again.assertRedirect('/sign-up')
  })
})
