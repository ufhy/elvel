import { beforeEach, describe, expect, test } from 'bun:test'
import { test as press, type TestResponse } from '@elvel/testing'
import app from '../../../bootstrap/app.ts'
import '../../../tests/database.ts'

/**
 * What a form is *told*, not what it answers with.
 *
 * The rest of these tests assert statuses and destinations, and every one of them
 * passed while people were shown things like this — measured against a running
 * application, before this file existed:
 *
 * ```
 * [body.email] Invalid email address; [body.password] Too small: expected string to have >=1 characters
 * Invalid two factor cookie
 * {\n  "type": "validation",\n  "on": "body",\n  "property": "/password"…
 * ```
 *
 * and "Password too short" was shown under the **email** field. A status code
 * cannot see any of that. So this reads the sentence and the field it arrived
 * under, which is exactly what somebody staring at the form sees.
 *
 * These are the shape a client sees, because this kit's forms post JSON:
 * `withErrors` becomes a 422 `{ message, errors }` rather than a redirect and a
 * session flash a shell would never render.
 */
beforeEach(async () => {
  await app.make('cache').store('array').flush()
})

/**
 * A JSON submission, the way `useForm` sends one.
 *
 * The token comes from `GET /api/session` and that response carries the cookie the
 * post has to travel with: minting a token makes the session dirty, so the page's
 * own cookie names a session that has no token. `tests/csrf.ts` does the same for
 * the form-shaped tests.
 */
async function send(
  method: 'POST' | 'DELETE',
  path: string,
  body: Record<string, unknown>,
  as?: TestResponse
): Promise<TestResponse> {
  const session = as
    ? await press(app).withCookiesFrom(as).get('/api/session')
    : await press(app).get('/api/session')

  const token = (session.json() as { csrf: string }).csrf
  const client = as
    ? press(app).withCookiesFrom(as).withCookiesFrom(session)
    : press(app).withCookiesFrom(session)

  // `/api`, the way `lib/form.ts` sends it — the call sites name the screen's
  // address and this puts the writes where the backend keeps them.
  return client.json(method, `/api${path}`, { _token: token, ...body })
}

/** Just the bag, for the tests that only read sentences. */
const bagOf = (answer: TestResponse) =>
  (answer.json() as { errors?: Record<string, string[]> }).errors ?? {}

async function submit(
  path: string,
  body: Record<string, unknown>,
  as?: TestResponse
): Promise<Record<string, string[]>> {
  return bagOf(await send('POST', path, body, as))
}

const address = () => `ada-${Math.random().toString(36).slice(2)}@example.com`

describe('the sentences a sign-up form shows', () => {
  test('a blank form names every field, and says the same thing about each', async () => {
    const errors = await submit('/sign-up', { name: '', email: '', password: '' })

    expect<string[]>(Object.keys(errors).sort()).toEqual(['email', 'name', 'password'])
    expect<string>(errors.name?.[0] as string).toBe('The name field is required.')
    expect<string>(errors.email?.[0] as string).toBe('The email field is required.')
    expect<string>(errors.password?.[0] as string).toBe('The password field is required.')
  })

  test('an address that is not one says so, on the address', async () => {
    const errors = await submit('/sign-up', {
      name: 'Ada',
      email: 'not-an-email',
      password: 'longenough1'
    })

    expect<string>(errors.email?.[0] as string).toBe('The email field is not valid.')
  })

  /**
   * The field this is about, which is the half a message cannot get right.
   *
   * "Password too short" used to arrive under `email`, so the input somebody had
   * typed correctly was the one marked in red.
   */
  test('a short password is marked on the password, not on the address', async () => {
    const errors = await submit('/sign-up', { name: 'Ada', email: address(), password: 'abc' })

    expect<string[]>(Object.keys(errors)).toEqual(['password'])
  })

  test('an address already in use is marked on the address', async () => {
    const email = address()

    await submit('/sign-up', { name: 'Ada', email, password: 'longenough1' })

    const errors = await submit('/sign-up', { name: 'Ada', email, password: 'longenough1' })

    expect<string[]>(Object.keys(errors)).toEqual(['email'])
    // better-auth's own wording, kept because it says what no form could know.
    expect<boolean>(String(errors.email?.[0]).includes('already exists')).toBe(true)
  })

  /**
   * Nothing internal reaches the page, on any of these.
   *
   * `[body.…]` is a validator path and `newEmail` is a better-auth field that
   * appears on no form in this application. Both were shown to people.
   */
  test('and no message carries a validator path or a schema dump', async () => {
    const all = [
      await submit('/sign-up', { name: '', email: '', password: '' }),
      await submit('/sign-up', { name: 'Ada', email: 'nope', password: 'longenough1' }),
      await submit('/sign-up', { name: 'Ada', email: address() })
    ]

    for (const said of all.flatMap((bag) => Object.values(bag).flat())) {
      expect<boolean>(said.includes('[body.')).toBe(false)
      expect<boolean>(said.includes('newEmail')).toBe(false)
      expect<boolean>(said.includes('"type"')).toBe(false)
      expect<boolean>(said.includes('undefined')).toBe(false)
      // A sentence, which is what the space under an input is for.
      expect<boolean>(said.endsWith('.')).toBe(true)
    }
  })
})

describe('the other forms', () => {
  test('signing in wrongly says neither which half was wrong', async () => {
    const email = address()

    await submit('/sign-up', { name: 'Ada', email, password: 'longenough1' })

    const wrong = await submit('/sign-in', { email, password: 'not-the-password' })
    const unknown = await submit('/sign-in', { email: address(), password: 'longenough1' })

    // The same sentence for both, or the form becomes a way to ask which
    // addresses have accounts.
    expect<string>(wrong.email?.[0] as string).toBe(unknown.email?.[0] as string)
  })

  test('a wrong second factor talks about the code', async () => {
    const errors = await submit('/two-factor-challenge', { code: '000000' })

    // Not `Invalid two factor cookie`, which is what better-auth calls it.
    expect<string>(errors.code?.[0] as string).toBe('That code did not work.')
  })

  test('an expired reset link says to ask for another', async () => {
    const errors = await submit('/reset-password', {
      token: 'not-a-real-token',
      password: 'longenough1',
      password_confirmation: 'longenough1'
    })

    expect<string>(errors.password?.[0] as string).toBe('That link has expired. Ask for another.')
  })

  test('and deleting an account marks the password it asked for', async () => {
    // The signed-in session is the *sign-up response*, not a session fetched
    // before it: signing up rotates the id, so anything older is a guest.
    const signedIn = await send('POST', '/sign-up', {
      name: 'Ada',
      email: address(),
      password: 'longenough1'
    })

    const refused = await send(
      'DELETE',
      '/settings/profile',
      { password: 'not-the-password' },
      signedIn
    )

    // Under `password`. It used to be under `name`, a field this form does not have.
    expect<string[]>(Object.keys(bagOf(refused))).toEqual(['password'])
  })
})
