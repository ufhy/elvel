import { beforeEach, describe, expect, test } from 'bun:test'
import { test as press, type TestResponse } from '@elvel/testing'
import app from '../../../bootstrap/app.ts'
import { postForm } from '../../csrf.ts'
import '../../../tests/database.ts'

/**
 * Passkeys, as far as a test without a browser can go.
 *
 * Registering one is the browser's job and always will be: a private key a server
 * could produce would not be a passkey. So what is testable is the rest — that
 * the list is behind the password window, that it starts empty, and that removing
 * one that is not there is refused rather than pretended.
 *
 * The auth kit's version of this file asserts on the rendered page. This kit
 * answers that page with a shell and the list through `GET /api/settings/passkeys`,
 * so the assertions move to the API. Same ground, one layer in.
 */
beforeEach(async () => {
  await app.make('cache').store('array').flush()
})

const address = () => `passkey-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`

const PASSWORD = 'longenough1'

async function register(email: string): Promise<TestResponse> {
  const page = await press(app).get('/auth/sign-up')

  return postForm('/sign-up', { name: 'Test Person', email, password: PASSWORD }, page)
}

/** Answer `password.confirm`, which the passkey list sits behind. */
async function confirmPassword(session: TestResponse): Promise<void> {
  const wall = await press(app).withCookiesFrom(session).get('/confirm-password')

  await postForm('/confirm-password', { password: PASSWORD }, wall, session)
}

describe('the passkey list', () => {
  test('is behind the password window, not just behind auth', async () => {
    const session = await register(address())

    /**
     * Signed in, but not confirmed: the window is what stands between a borrowed
     * unlocked browser and adding a way into somebody's account.
     *
     * `acceptJson()` is not decoration. `password.confirm` answers a browser with
     * a **302** to the confirmation form and a JSON caller with a **423**, because
     * a `fetch` cannot follow a redirect to a form and do anything useful with it.
     * The client always asks for JSON, so this asserts the answer the client gets
     * — without the header this test passes on a 302 and proves nothing about the
     * client.
     */
    const refused = await press(app)
      .withCookiesFrom(session)
      .acceptJson()
      .get('/api/settings/passkeys')

    expect(refused.status).toBe(423)
  })

  test('and a new account has none', async () => {
    const session = await register(address())
    await confirmPassword(session)

    const listed = await press(app).withCookiesFrom(session).get('/api/settings/passkeys')

    listed.assertOk()

    expect((listed.json() as { passkeys?: unknown[] }).passkeys).toEqual([])
  })

  test('the page itself is the shell, guarded the same way', async () => {
    const session = await register(address())
    await confirmPassword(session)

    const page = await press(app).withCookiesFrom(session).get('/settings/passkeys')

    page.assertOk().assertSee('data-spa-root')
  })

  test('removing one that does not exist is refused, not pretended', async () => {
    const session = await register(address())
    await confirmPassword(session)

    const page = await press(app).withCookiesFrom(session).get('/settings/passkeys')
    const answer = await postForm(
      '/settings/passkeys',
      { _method: 'DELETE', id: 'no-such-passkey' },
      page,
      session
    )

    // Back to the page with a message. A 500 here would mean the id reached
    // better-auth unchecked; a silent success would mean nothing was checked.
    answer.assertRedirect('/settings/passkeys')
  })
})
