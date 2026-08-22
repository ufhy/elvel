import { beforeEach, describe, expect, test } from 'bun:test'
import { test as press, type TestResponse } from '@elvel/testing'
import app from '../../../bootstrap/app.ts'
import '../../../tests/database.ts'

/**
 * Two-factor authentication, all the way through.
 *
 * The interesting part of this feature is not any one request — it is that six of
 * them agree: enrol, confirm, sign out, sign in, get challenged, answer. Each
 * step alone looks right while the whole thing is broken, which is exactly what
 * happened here twice while it was being written: `enableTwoFactor` was called
 * without the request headers and answered 401 behind a page that still rendered
 * its "set it up" form, and a recovery field was named `recovery` while the route
 * read `code`. Neither showed up as an error anywhere.
 */
beforeEach(async () => {
  await app.make('cache').store('array').flush()
})

const tokenIn = (html: string): string => {
  const found = /name="_token" value="([^"]+)"/.exec(html)?.[1]

  if (!found) throw new Error('No CSRF token on the page. Is SESSION_CSRF off?')

  return found
}

const address = () => `2fa-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`

const PASSWORD = 'longenough1'

/**
 * A TOTP code, the way an authenticator app computes one.
 *
 * RFC 6238 over RFC 4226: base32-decode the secret, HMAC-SHA1 the 30-second
 * counter, and read six digits out of the offset the last nibble points at. It is
 * written out here rather than imported so that this file needs no dependency
 * beyond what the application already has — and it cannot quietly be wrong,
 * because the only assertion it feeds is the server accepting the code.
 */
async function totp(base32Secret: string): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''

  for (const character of base32Secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character)

    if (index === -1) continue

    bits += index.toString(2).padStart(5, '0')
  }

  const bytes = new Uint8Array(Math.floor(bits.length / 8))

  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)
  }

  /**
   * better-auth stores the secret as text and base32-encodes it for the URI, so
   * the bytes above are that text — and the HMAC key is the text, not the bytes
   * of some further decoding. Getting this backwards produces codes that look
   * perfectly plausible and are always rejected.
   */
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign'
  ])

  const counter = Math.floor(Date.now() / 1000 / 30)
  const message = new DataView(new ArrayBuffer(8))
  message.setUint32(0, Math.floor(counter / 2 ** 32))
  message.setUint32(4, counter % 2 ** 32)

  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message.buffer))
  const offset = (digest.at(-1) as number) & 0x0f
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    ((digest[offset + 1] as number) << 16) |
    ((digest[offset + 2] as number) << 8) |
    (digest[offset + 3] as number)

  return String(binary % 1_000_000).padStart(6, '0')
}

/** Register, and hand back the response whose cookies carry the session. */
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

/** Answer `password.confirm`, which the two-factor page sits behind. */
async function confirmPassword(session: TestResponse): Promise<void> {
  const wall = await press(app).withCookiesFrom(session).get('/confirm-password')

  await press(app)
    .withCookiesFrom(session)
    .form('POST', '/confirm-password', { _token: tokenIn(wall.body), password: PASSWORD })
}

/**
 * Enrol, and answer with the secret *and* the page that showed it.
 *
 * Both, because the enrolment is flashed: it is on the page for exactly one
 * request, and a second GET is the "off" state again. Handing the body back is
 * what lets a caller assert about what was on screen without fetching it a second
 * time and finding nothing — which it did, on the first run of this file.
 *
 * The secret is read out of the page rather than out of the API on purpose: what
 * the QR code encodes is what somebody's phone will hold, so that is the value
 * that has to work.
 */
async function enrol(session: TestResponse): Promise<{ secret: string; page: TestResponse }> {
  const form = await press(app).withCookiesFrom(session).get('/settings/two-factor')

  await press(app)
    .withCookiesFrom(session)
    .form('POST', '/settings/two-factor', { _token: tokenIn(form.body), password: PASSWORD })

  const page = await press(app).withCookiesFrom(session).get('/settings/two-factor')
  const secret = /<code[^>]*>([A-Z2-7]{16,})<\/code>/.exec(page.body)?.[1]

  if (!secret) throw new Error('The enrolment page showed no secret to scan.')

  return { secret, page }
}

describe('turning two-factor on', () => {
  test('the page is behind password confirmation', async () => {
    const session = await register(address())
    const page = await press(app).withCookiesFrom(session).get('/settings/two-factor')

    page.assertRedirect('/confirm-password')
  })

  test('enrolling shows a QR code, a key and recovery codes', async () => {
    const session = await register(address())
    await confirmPassword(session)
    const { page } = await enrol(session)

    // The QR code is an inline SVG, rendered from the URI on the server.
    expect(page.body).toContain('<svg')
    expect(page.body).toContain('Turn it on')
    /**
     * Ten codes, each shown once — counted without assuming the markup.
     *
     * `xxxxx-xxxxx` is better-auth's format, and it was matched as
     * `<li>…</li>`, which is only how *one* of these kits renders it: the
     * unstyled one wraps each code in a `<code>` inside the `<li>` and the count
     * came back 0. Bounded by the tags on either side rather than by which tags
     * they are — unbounded, the pattern matches hashed asset names and Tailwind
     * class fragments by the hundred.
     */
    expect((page.body.match(/>[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}</g) ?? []).length).toBe(10)
  })

  /**
   * Shown once, and once only.
   *
   * The enrolment is flashed rather than stored, so a reload does not put the
   * secret and the recovery codes back on screen. Anything else would leave them
   * one browser-history entry away for as long as the page existed.
   */
  test('and only once — a reload does not show them again', async () => {
    const session = await register(address())
    await confirmPassword(session)
    await enrol(session)

    const again = await press(app).withCookiesFrom(session).get('/settings/two-factor')

    expect(again.body).not.toContain('Turn it on')
    expect(again.body).not.toContain('Save these now')
  })

  test('a wrong password gets nowhere', async () => {
    const session = await register(address())
    await confirmPassword(session)

    const page = await press(app).withCookiesFrom(session).get('/settings/two-factor')
    await press(app)
      .withCookiesFrom(session)
      .form('POST', '/settings/two-factor', {
        _token: tokenIn(page.body),
        password: 'not-the-password'
      })

    const again = await press(app).withCookiesFrom(session).get('/settings/two-factor')

    expect(again.body).not.toContain('Turn it on')
    expect(again.body).toContain('Set it up')
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
    const signedIn = await press(app)
      .withCookiesFrom(form)
      .form('POST', '/sign-in', { _token: tokenIn(form.body), email, password: PASSWORD })

    signedIn.assertRedirect('/dashboard')
  })
})

describe('signing in with two-factor on', () => {
  /** Enrol *and* confirm, which is what leaves an account actually protected. */
  const protectedAccount = async (email: string): Promise<string> => {
    const session = await register(email)
    await confirmPassword(session)
    const { secret, page } = await enrol(session)

    const confirmed = await press(app)
      .withCookiesFrom(session)
      .form('POST', '/settings/two-factor/confirm', {
        _token: tokenIn(page.body),
        code: await totp(secret)
      })

    confirmed.assertRedirect('/settings/two-factor?on=1')

    return secret
  }

  test('the password alone lands on the challenge, and the code finishes it', async () => {
    const email = address()
    const secret = await protectedAccount(email)

    const form = await press(app).get('/sign-in')
    const challenged = await press(app)
      .withCookiesFrom(form)
      .form('POST', '/sign-in', { _token: tokenIn(form.body), email, password: PASSWORD })

    // No session yet — what came back is the two-factor cookie and a redirect.
    challenged.assertRedirect('/two-factor-challenge')

    const page = await press(app).withCookiesFrom(challenged).get('/two-factor-challenge')

    expect(page.status).toBe(200)

    const dashboard = await press(app)
      .withCookiesFrom(challenged)
      .form('POST', '/two-factor-challenge', {
        _token: tokenIn(page.body),
        code: await totp(secret)
      })

    dashboard.assertRedirect('/dashboard')
  })

  test('a wrong code stays on the challenge', async () => {
    const email = address()
    await protectedAccount(email)

    const form = await press(app).get('/sign-in')
    const challenged = await press(app)
      .withCookiesFrom(form)
      .form('POST', '/sign-in', { _token: tokenIn(form.body), email, password: PASSWORD })

    const page = await press(app).withCookiesFrom(challenged).get('/two-factor-challenge')
    const refused = await press(app)
      .withCookiesFrom(challenged)
      .form('POST', '/two-factor-challenge', { _token: tokenIn(page.body), code: '000000' })

    refused.assertRedirect('/two-factor-challenge')
  })
})
