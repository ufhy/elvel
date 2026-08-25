import { beforeEach, describe, expect, test } from 'bun:test'
import { test as press, type TestResponse } from '@elvel/testing'
import app from '../../../bootstrap/app.ts'
import { postForm } from '../../csrf.ts'
import '../../../tests/database.ts'

/**
 * The kit's own flows, as tests you own.
 *
 * These are yours to change: they came with the kit so that the pages it ships
 * are covered from the first day, and so there is a worked example of the two
 * things every test of an authenticated application has to do — carry cookies
 * between requests, and send the CSRF token.
 *
 * Both live in `tests/csrf.ts`, which is the one file that differs between the
 * server-rendered kits and the Vue one: there the pages are shells and the token
 * is fetched from `/api/session` rather than read out of the form.
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

/** A unique address per run, so a re-run is not a duplicate registration. */
const address = () => `test-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`

/**
 * Register, and answer with the response that carries the session cookie.
 *
 * The page is fetched first, for its cookies and for whatever `postForm` needs
 * from it: a session that has never been written to has no token to check
 * against, and posting without one is a 419 rather than a failure of whatever
 * was being tested.
 */
async function register(email: string, password = 'longenough1'): Promise<TestResponse> {
  const page = await press(app).get('/sign-up')

  return postForm('/sign-up', { name: 'Test Person', email, password }, page)
}

describe('signing in', () => {
  test('the right password reaches the dashboard', async () => {
    const email = address()
    await register(email)

    const page = await press(app).get('/sign-in')
    const signedIn = await postForm('/sign-in', { email, password: 'longenough1' }, page)

    signedIn.assertRedirect('/dashboard')
  })

  test('a wrong one goes back to the form', async () => {
    const email = address()
    await register(email)

    const page = await press(app).get('/sign-in')
    const refused = await postForm('/sign-in', { email, password: 'not-the-password' }, page)

    refused.assertRedirect('/sign-in')
  })
})

describe('the pages behind auth', () => {
  test('a guest is sent to sign in', async () => {
    const response = await press(app).get('/dashboard')

    response.assertRedirect('/sign-in')
  })

  test('and a signed-in visitor is sent away from the sign-in page', async () => {
    const registered = await register(address())
    const response = await press(app).withCookiesFrom(registered).get('/sign-in')

    response.assertRedirect('/dashboard')
  })
})

describe('CSRF', () => {
  test('a form posted without its token is refused', async () => {
    const response = await press(app).form('POST', '/sign-in', {
      email: 'nobody@example.com',
      password: 'whatever'
    })

    // 419, not 500 and not a sign-in attempt: the token is what proves the form
    // came from a page this application served.
    expect(response.status).toBe(419)
  })
})
