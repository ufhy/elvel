import { beforeEach, describe, expect, test } from 'bun:test'
import { test as press, type TestResponse } from '@elvel/testing'
import app from '../../../bootstrap/app.ts'
import '../../../tests/database.ts'

/**
 * Passkeys, as far as a test without a browser can go.
 *
 * The ceremony itself cannot be here: `navigator.credentials` is a browser API and
 * a passkey is a key held by a device, so registering and signing in are verified
 * against a real browser with a virtual authenticator. What *is* here is
 * everything that decides whether that ceremony can start — and it is the half
 * that broke.
 *
 * The button on the settings page rendered perfectly and did nothing, because
 * `data-passkey` was handed to a component that only renders the props it names
 * and the attribute was dropped. Nothing about the page said so: the button was
 * there, it was styled, it was the right size, and no script was listening. So
 * these tests read the attributes the script depends on, out of the rendered page.
 */
beforeEach(async () => {
  await app.make('cache').store('array').flush()
})

const tokenIn = (html: string): string => {
  const found = /name="_token" value="([^"]+)"/.exec(html)?.[1]

  if (!found) throw new Error('No CSRF token on the page. Is SESSION_CSRF off?')

  return found
}

const address = () => `pk-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`

const PASSWORD = 'longenough1'

async function register(email: string): Promise<TestResponse> {
  const page = await press(app).get('/sign-up')

  return await press(app)
    .withCookiesFrom(page)
    .form('POST', '/sign-up', {
      _token: tokenIn(page.body),
      name: 'Test Person',
      email,
      password: PASSWORD
    })
}

async function confirmPassword(session: TestResponse): Promise<void> {
  const wall = await press(app).withCookiesFrom(session).get('/confirm-password')

  await press(app)
    .withCookiesFrom(session)
    .form('POST', '/confirm-password', { _token: tokenIn(wall.body), password: PASSWORD })
}

describe('the passkey settings page', () => {
  test('it is behind password confirmation', async () => {
    const session = await register(address())
    const page = await press(app).withCookiesFrom(session).get('/settings/passkeys')

    page.assertRedirect('/confirm-password')
  })

  test('a new account has none, and can start adding one', async () => {
    const session = await register(address())
    await confirmPassword(session)

    const page = await press(app).withCookiesFrom(session).get('/settings/passkeys')

    expect(page.status).toBe(200)
    expect(page.body).toContain('None yet.')

    /**
     * The three things the script needs, checked in the rendered HTML.
     *
     * Miss any one and the button is inert: the listener never fires, the name
     * is never read, or the failure has nowhere to be written.
     */
    expect(page.body).toContain('data-passkey="register"')
    expect(page.body).toContain('id="passkey-name"')
    expect(page.body).toContain('data-passkey-error')
  })

  test('removing a passkey that is not there fails without a stack trace', async () => {
    const session = await register(address())
    await confirmPassword(session)

    const page = await press(app).withCookiesFrom(session).get('/settings/passkeys')
    const answer = await press(app)
      .withCookiesFrom(session)
      .form('POST', '/settings/passkeys', {
        _token: tokenIn(page.body),
        _method: 'DELETE',
        id: 'no-such-passkey'
      })

    // A redirect carrying a message, not a 500 — the id comes from the page, so
    // a stale one is an ordinary thing to receive.
    expect(answer.status).toBeGreaterThanOrEqual(300)
    expect(answer.status).toBeLessThan(400)
  })
})

describe('the sign-in page', () => {
  test('it offers a passkey, and the field invites one', async () => {
    const page = await press(app).get('/sign-in')

    expect(page.body).toContain('data-passkey="sign-in"')

    /**
     * `username webauthn`, which is what turns on conditional UI.
     *
     * Without `webauthn` in the autocomplete the browser will not offer a passkey
     * from the address field, and the whole autofill path silently becomes a
     * button nobody notices.
     */
    expect(page.body).toContain('autocomplete="username webauthn"')
    expect(page.body).toContain('data-passkey-autofill')
  })
})
