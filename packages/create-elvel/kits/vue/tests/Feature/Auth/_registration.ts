import { beforeEach, describe, expect, test } from 'bun:test'
import { test as press, type TestResponse } from '@elvel/testing'
import app from '../../../bootstrap/app.ts'
import { postForm } from '../../csrf.ts'
import '../../../tests/database.ts'

/**
 * Registration, asserted where this kit puts the answers.
 *
 * The auth kit's version of this file reads the name off the dashboard. Here the
 * dashboard is a shell — the markup is rendered by Vue in a browser, and
 * `press(app)` runs no browser — so asserting on it would be asserting that the
 * shell is a shell.
 *
 * What the server promises instead is `GET /api/session`, and that is what the
 * client reads on its first paint. Testing the promise rather than the page is
 * also the stronger test: a name on the dashboard could come from anywhere,
 * while this is the exact payload the application boots from.
 */
beforeEach(async () => {
  await app.make('cache').store('array').flush()
})

const address = () => `test-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`

async function register(email: string, password = 'longenough1'): Promise<TestResponse> {
  const page = await press(app).get('/auth/sign-up')

  return postForm('/sign-up', { name: 'Test Person', email, password }, page)
}

describe('registration', () => {
  test('creates an account and signs it in', async () => {
    const email = address()
    const registered = await register(email)

    registered.assertRedirect('/dashboard')

    // The shell answers, and it answers to somebody: `auth` would have redirected
    // a guest before any JavaScript loaded.
    const dashboard = await press(app).withCookiesFrom(registered).get('/dashboard')

    dashboard.assertOk().assertSee('data-spa-root')

    const session = await press(app).withCookiesFrom(registered).get('/api/session')
    const body = session.json() as { user?: { name?: string; email?: string } }

    expect(body.user?.name).toBe('Test Person')
    expect(body.user?.email).toBe(email)
  })

  test('refuses an address that is already taken', async () => {
    const email = address()
    await register(email)

    const again = await register(email)

    // Back to the form with an error, not a 500 and not a second account.
    again.assertRedirect('/auth/sign-up')
  })
})
