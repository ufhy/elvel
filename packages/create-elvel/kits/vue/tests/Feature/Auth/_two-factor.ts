import { beforeEach, describe, expect, test } from 'bun:test'
import { test as press, type TestResponse } from '@elvel/testing'
import app from '../../../bootstrap/app.ts'
import { postForm } from '../../csrf.ts'
import { totp } from '../../totp.ts'
import '../../../tests/database.ts'

/**
 * Two-factor authentication, all the way through.
 *
 * The interesting part of this feature is not any one request — it is that six of
 * them agree: enrol, confirm, sign out, sign in, get challenged, answer. Each
 * step alone looks right while the whole thing is broken, which is exactly what
 * happened twice while it was being written: `enableTwoFactor` was called without
 * the request headers and answered 401 behind a page that still rendered its "set
 * it up" form, and a recovery field was named `recovery` while the route read
 * `code`. Neither showed up as an error anywhere.
 *
 * This kit reads the enrolment from `GET /api/settings/two-factor` rather than
 * from the page, because the page is a shell — the QR code is drawn by Vue in a
 * browser, and there is no browser here. Not a weaker test: the secret in that
 * response is the one the QR encodes, so it is the value somebody's phone will
 * hold either way.
 */
beforeEach(async () => {
  await app.make('cache').store('array').flush()
})

const address = () => `2fa-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`

const PASSWORD = 'longenough1'

type Enrolment = { uri: string; secret: string; codes: string[] }

async function register(email: string): Promise<TestResponse> {
  const page = await press(app).get('/sign-up')

  return postForm('/sign-up', { name: 'Test Person', email, password: PASSWORD }, page)
}

/** Answer `password.confirm`, which the two-factor page sits behind. */
async function confirmPassword(session: TestResponse): Promise<void> {
  const wall = await press(app).withCookiesFrom(session).get('/confirm-password')

  await postForm('/confirm-password', { password: PASSWORD }, wall, session)
}

/** What the settings screen would show. */
async function readTwoFactor(
  session: TestResponse
): Promise<{ enabled?: boolean; pending?: Enrolment }> {
  const answer = await press(app).withCookiesFrom(session).get('/api/settings/two-factor')

  answer.assertOk()

  return answer.json() as { enabled?: boolean; pending?: Enrolment }
}

/**
 * Enrol, and answer with the secret.
 *
 * Read once, because the enrolment is flashed: it is available for exactly one
 * request and a second read is the "off" state again. That contract is the same
 * one the server-rendered kit has — it is what stops the secret sitting one
 * request away for as long as the session lives — and the test below asserts it.
 */
async function enrol(session: TestResponse): Promise<Enrolment> {
  const page = await press(app).withCookiesFrom(session).get('/settings/two-factor')

  await postForm('/settings/two-factor', { password: PASSWORD }, page, session)

  const { pending } = await readTwoFactor(session)

  if (!pending?.secret) throw new Error('The enrolment answered no secret to scan.')

  return pending
}

describe('turning two-factor on', () => {
  test('the page is a shell, and the enrolment comes from the API', async () => {
    const session = await register(address())
    await confirmPassword(session)

    const page = await press(app).withCookiesFrom(session).get('/settings/two-factor')

    page.assertOk().assertSee('data-spa-root')

    const { secret, codes } = await enrol(session)

    // A base32 secret, and ten recovery codes in better-auth's own format.
    expect(secret.length > 0).toBe(true)
    expect(codes.length).toBe(10)
    expect(codes.every((code) => /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/.test(code))).toBe(true)
  })

  /**
   * Shown once, and once only.
   *
   * The enrolment is flashed rather than stored, so a second read does not put
   * the secret and the recovery codes back.
   */
  test('and only once — a second read does not answer them again', async () => {
    const session = await register(address())
    await confirmPassword(session)
    await enrol(session)

    const { pending } = await readTwoFactor(session)

    expect(pending).toBeUndefined()
  })

  test('a wrong password gets nowhere', async () => {
    const session = await register(address())
    await confirmPassword(session)

    const page = await press(app).withCookiesFrom(session).get('/settings/two-factor')
    await postForm('/settings/two-factor', { password: 'not-the-password' }, page, session)

    const { enabled, pending } = await readTwoFactor(session)

    expect(enabled).toBe(false)
    expect(pending).toBeUndefined()
  })

  /**
   * Enrolment is not enablement.
   *
   * `enableTwoFactor` hands out a secret and leaves the account alone; only a
   * correct code turns it on. That order is the whole safety of the feature — a
   * mistyped setup must not be able to lock somebody out of their own account —
   * so it is asserted from the outside: sign in again and see no challenge.
   */
  test('until the first code is entered, a sign-in is unaffected', async () => {
    const email = address()
    const session = await register(email)
    await confirmPassword(session)
    await enrol(session)

    const form = await press(app).get('/sign-in')
    const signedIn = await postForm('/sign-in', { email, password: PASSWORD }, form)

    signedIn.assertRedirect('/dashboard')
  })
})

describe('signing in with two-factor on', () => {
  /** Enrol *and* confirm, which is what leaves an account actually protected. */
  const protectedAccount = async (email: string): Promise<string> => {
    const session = await register(email)
    await confirmPassword(session)
    const { secret } = await enrol(session)

    const page = await press(app).withCookiesFrom(session).get('/settings/two-factor')
    const confirmed = await postForm(
      '/settings/two-factor/confirm',
      { code: await totp(secret) },
      page,
      session
    )

    confirmed.assertRedirect('/settings/two-factor?on=1')

    return secret
  }

  test('the password alone lands on the challenge, and the code finishes it', async () => {
    const email = address()
    const secret = await protectedAccount(email)

    const form = await press(app).get('/sign-in')
    const challenged = await postForm('/sign-in', { email, password: PASSWORD }, form)

    // No session yet — what came back is the two-factor cookie and a redirect.
    challenged.assertRedirect('/two-factor-challenge')

    const page = await press(app).withCookiesFrom(challenged).get('/two-factor-challenge')

    expect(page.status).toBe(200)

    const dashboard = await postForm(
      '/two-factor-challenge',
      { code: await totp(secret) },
      page,
      challenged
    )

    dashboard.assertRedirect('/dashboard')
  })

  test('a wrong code stays on the challenge', async () => {
    const email = address()
    await protectedAccount(email)

    const form = await press(app).get('/sign-in')
    const challenged = await postForm('/sign-in', { email, password: PASSWORD }, form)

    const page = await press(app).withCookiesFrom(challenged).get('/two-factor-challenge')
    const refused = await postForm('/two-factor-challenge', { code: '000000' }, page, challenged)

    refused.assertRedirect('/two-factor-challenge')
  })
})
