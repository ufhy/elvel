import { describe, expect, test } from 'bun:test'
import { test as press } from '@elysian/testing'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * The kit's endpoints, as tests you own.
 *
 * These are yours to change. They came with the kit so its routes are covered
 * from the first day, and because an API test looks different from a browser
 * one: no cookies, no CSRF token to find, and a bearer token carried by hand
 * from the response that issued it.
 *
 * `press(app)` runs a request through the same `handle()` a server would, so
 * the middleware and the exception handler take part. There is no server to
 * start and no port to pick.
 */

/** Unique per run, so re-running is not a duplicate registration. */
const address = () => `test-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`

async function register(email: string): Promise<{ token: string }> {
  const response = await press(app).postJson('/api/register', {
    name: 'Test Person',
    email,
    password: 'longenough1'
  })

  response.assertStatus(201)

  return (await response.json()) as { token: string }
}

describe('registering', () => {
  test('answers a token and the user it made', async () => {
    const email = address()
    const response = await press(app).postJson('/api/register', {
      name: 'Test Person',
      email,
      password: 'longenough1'
    })

    response.assertStatus(201).assertJsonPath('user.email', email)

    expect(((await response.json()) as { token?: string }).token).toBeTruthy()
  })
})

describe('the token', () => {
  test('identifies the caller', async () => {
    const email = address()
    const { token } = await register(email)

    const response = await press(app)
      .withHeader('authorization', `Bearer ${token}`)
      .getJson('/api/user')

    response.assertOk().assertJsonPath('user.email', email)
  })

  test('and without one the answer is 401, not a redirect', async () => {
    const response = await press(app).getJson('/api/user')

    // A redirect to a sign-in page would be a client library's worst day, and
    // this kit has no such page. The framework decides this from `Accept`.
    response.assertStatus(401)
  })
})

describe('signing in', () => {
  test('the right password answers a token', async () => {
    const email = address()
    await register(email)

    const response = await press(app).postJson('/api/login', {
      email,
      password: 'longenough1'
    })

    response.assertOk()
    expect(((await response.json()) as { token?: string }).token).toBeTruthy()
  })

  test('a wrong one is 401 with a message rather than a page', async () => {
    const email = address()
    await register(email)

    const response = await press(app).postJson('/api/login', {
      email,
      password: 'not-the-password'
    })

    response.assertStatus(401)
    expect(((await response.json()) as { message?: string }).message).toBeTruthy()
  })
})

describe('signing out', () => {
  test('ends that token and leaves other sessions alone', async () => {
    const email = address()
    const first = await register(email)

    const second = (await (
      await press(app).postJson('/api/login', { email, password: 'longenough1' })
    ).json()) as { token: string }

    const out = await press(app)
      .withHeader('authorization', `Bearer ${second.token}`)
      .postJson('/api/logout')

    out.assertStatus(204)

    // The token *is* the session, so it dies at the source rather than being
    // forgotten by a well-behaved client — and the other session is untouched.
    ;(
      await press(app).withHeader('authorization', `Bearer ${second.token}`).getJson('/api/user')
    ).assertStatus(401)
    ;(
      await press(app).withHeader('authorization', `Bearer ${first.token}`).getJson('/api/user')
    ).assertOk()
  })
})
