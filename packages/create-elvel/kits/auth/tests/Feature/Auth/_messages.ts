import { beforeEach, describe, expect, test } from 'bun:test'
import { test as press } from '@elvel/testing'
import app from '../../../bootstrap/app.ts'
import { postForm } from '../../csrf.ts'
import '../../../tests/database.ts'

/**
 * What a form is *told*, read off the rendered page.
 *
 * Every other test in this kit asserts a status or a destination, and all of them
 * passed while people were being shown this — measured against a running
 * application, before this file existed:
 *
 * ```
 * [body.email] Invalid email address; [body.password] Too small: expected string to have >=1 characters
 * Invalid two factor cookie
 * ```
 *
 * A status code cannot see any of that. So this submits a form, follows it to the
 * page it lands on, and reads the sentence that is actually printed there.
 *
 * The messages come from the session flash and the page renders `errors().first()`
 * — the first thing that went wrong, whatever field it was filed under. Naming a
 * field there is how a page ends up rendering nothing at all the day an error is
 * filed correctly somewhere else.
 */
beforeEach(async () => {
  await app.make('cache').store('array').flush()
})

const address = () => `ada-${Math.random().toString(36).slice(2)}@example.com`

/**
 * Submit, then read the page it redirected to.
 *
 * `from` is the address the form is *on*, which is not always the address it posts
 * to: `/reset-password` with no token in the query bounces to `/forgot-password`,
 * so there is no form there to take a token from.
 */
async function shown(
  path: string,
  fields: Record<string, string>,
  from: string = path
): Promise<string> {
  const page = await press(app).get(from)
  const answer = await postForm(path, fields, page)
  const to = answer.headers.get('location') ?? path
  const landed = await press(app).withCookiesFrom(answer).get(to)

  return String(landed.body)
}

describe('the sentence a sign-up page prints', () => {
  test('a blank form is told which field, in prose', async () => {
    const page = await shown('/sign-up', { name: '', email: '', password: '' })

    expect<boolean>(page.includes('The name field is required.')).toBe(true)
  })

  test('an address that is not one says so', async () => {
    const page = await shown('/sign-up', {
      name: 'Ada',
      email: 'not-an-email',
      password: 'longenough1'
    })

    expect<boolean>(page.includes('The email field is not valid.')).toBe(true)
  })

  /**
   * A short password is shown at all, which is the half a field name decides.
   *
   * It is filed under `password` now, and the page reads the first error rather
   * than the email one — either half alone leaves the page blank.
   */
  test('a short password is shown, not swallowed', async () => {
    const page = await shown('/sign-up', { name: 'Ada', email: address(), password: 'abc' })

    expect<boolean>(page.includes('Password too short')).toBe(true)
  })

  /**
   * Nothing internal reaches the page.
   *
   * `[body.…]` is a validator path, `newEmail` is a better-auth field that appears
   * on no form here, and `found: undefined` is a sentence about the program. All
   * three were printed to people.
   */
  test('and no internal wording is printed anywhere', async () => {
    const pages = [
      await shown('/sign-up', { name: '', email: '', password: '' }),
      await shown('/sign-up', { name: 'Ada', email: 'nope', password: 'longenough1' }),
      await shown('/sign-in', { email: '', password: '' })
    ]

    for (const page of pages) {
      // Inside the `<p class="error">` only: the markup itself may say `body`.
      const printed = /<p class="error"[^>]*>([\s\S]*?)<\/p>/.exec(page)?.[1] ?? ''

      expect<boolean>(printed.includes('[body.')).toBe(false)
      expect<boolean>(printed.includes('newEmail')).toBe(false)
      expect<boolean>(printed.includes('undefined')).toBe(false)
      expect<boolean>(printed.includes('"type"')).toBe(false)
    }
  })
})

describe('the other pages', () => {
  test('a wrong second factor is told about the code', async () => {
    const page = await shown('/two-factor-challenge', { code: '000000' })

    // Not `Invalid two factor cookie`, which is what better-auth calls it.
    expect<boolean>(page.includes('That code did not work.')).toBe(true)
  })

  test('an expired reset link says to ask for another', async () => {
    const page = await shown(
      '/reset-password',
      {
        token: 'not-a-real-token',
        password: 'longenough1',
        password_confirmation: 'longenough1'
      },
      '/reset-password?token=not-a-real-token'
    )

    expect<boolean>(page.includes('That link has expired. Ask for another.')).toBe(true)
  })

  test('and signing in wrongly says neither half', async () => {
    const email = address()
    const form = await press(app).get('/sign-up')

    await postForm('/sign-up', { name: 'Ada', email, password: 'longenough1' }, form)

    const wrong = await shown('/sign-in', { email, password: 'not-the-password' })
    const unknown = await shown('/sign-in', { email: address(), password: 'longenough1' })

    // The same sentence for both, or the page becomes a way to ask which
    // addresses have accounts.
    expect<boolean>(wrong.includes('Those details did not match.')).toBe(true)
    expect<boolean>(unknown.includes('Those details did not match.')).toBe(true)
  })
})
