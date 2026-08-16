import { describe, expect, test } from 'bun:test'
import { test as press, type TestResponse } from '@elysian/testing'
import app from '../bootstrap/app.ts'
import './database.ts'

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

describe('signing in', () => {
  test('the right password reaches the dashboard', async () => {
    const email = address()
    await register(email)

    const page = await press(app).get('/sign-in')
    const signedIn = await press(app)
      .withCookiesFrom(page)
      .form('POST', '/sign-in', { _token: tokenIn(page.body), email, password: 'longenough1' })

    signedIn.assertRedirect('/dashboard')
  })

  test('a wrong one goes back to the form', async () => {
    const email = address()
    await register(email)

    const page = await press(app).get('/sign-in')
    const refused = await press(app)
      .withCookiesFrom(page)
      .form('POST', '/sign-in', { _token: tokenIn(page.body), email, password: 'not-the-password' })

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
