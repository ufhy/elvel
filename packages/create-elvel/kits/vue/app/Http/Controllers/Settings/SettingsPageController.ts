import { api, sessionSummaries, user, userOf } from '@elvel/auth'
import { controller } from '@elvel/core'
import { currentScope, errors, middleware } from '@elvel/http'
import { document } from '@elvel/spa'

/**
 * The settings screens, answered with the document the Vue client boots from.
 *
 * The same arrangement as `Auth/AuthPageController`, for the same reason: mounted
 * after the auth kit's settings controllers in `routes/web.ts`, and in Elysia the
 * last registration of a path wins. Those controllers keep every action — saving a
 * profile, rotating a password, revoking a session, enrolling a second factor — and
 * not a line of them is edited or copied.
 *
 * The guards are repeated because shadowing a handler shadows its middleware, and
 * three of these are behind `password.confirm` on purpose: reading which devices
 * are signed in, and cutting any of them off, is where a borrowed unlocked browser
 * does real damage.
 */

/** One passkey, as a page needs it. */
type PasskeyRow = {
  id: string
  name: string
  createdAt?: string | undefined
  deviceType?: string | undefined
}

/**
 * Four fields, not the row better-auth stores.
 *
 * The payload travels inside the document, so what goes in it is what the page
 * renders and nothing else — a credential's key material and counters have no
 * business in the HTML.
 */
function passkeyRows(listed: unknown): PasskeyRow[] {
  if (!Array.isArray(listed)) return []

  return listed.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []

    const row = entry as Record<string, unknown>

    if (typeof row.id !== 'string') return []

    return [
      {
        id: row.id,
        // A passkey registered without a name is still a passkey.
        name: typeof row.name === 'string' && row.name.trim() ? row.name : 'Unnamed passkey',
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : undefined,
        deviceType: typeof row.deviceType === 'string' ? row.deviceType : undefined
      }
    ]
  })
}

export default controller('vue-settings-pages')
  .get(
    '/settings/profile',
    (context) => {
      const person = userOf(context)

      return document({
        title: 'Profile',
        payload: {
          name: person.name,
          email: person.email,
          emailVerified: person.emailVerified,
          // Set when the address was changed and the new one is unconfirmed.
          pending: context.query.pending === '1',
          saved: context.query.saved === '1',
          error: errors().first('name') ?? errors().first('email')
        }
      })
    },
    middleware('auth')
  )

  /**
   * Appearance has no data and no action, and still needs a route.
   *
   * Without one it is only a client route, so the SPA fallback answers it — and a
   * fallback cannot refuse a guest. That left a signed-out visitor looking at the
   * settings shell with nothing in it. `auth` here is the whole point of the
   * handler; the document it returns is the same one every other page gets.
   */
  .get('/settings/appearance', () => document({ title: 'Appearance' }), middleware('auth'))

  .get(
    '/settings/password',
    /**
     * `saved` comes from the query, and it has to.
     *
     * Changing a password revokes every other session and comes back with fresh
     * cookies, so this form cannot stay client-side the way `/forgot-password`
     * does — the document it was submitted from is out of date the moment it
     * succeeds. The server redirects to `?saved=1`, a new document arrives, and
     * this is how the page knows to say so.
     */
    ({ query }) =>
      document({
        title: 'Password',
        payload: { saved: query.saved === '1', error: errors().first('password') }
      }),
    middleware('auth')
  )

  .get(
    '/settings/two-factor',
    ({ query }) => {
      /**
       * The enrolment in progress, flashed by the step before.
       *
       * Turning two-factor on is two steps — take a secret, then prove it was
       * scanned — and the URI, the secret and the ten recovery codes sit in the
       * session for exactly one request between them. Shown once and never again,
       * which is why the page has to receive them rather than ask for them.
       */
      const pending = currentScope()?.session.get('two-factor.pending') as
        | { uri: string; secret: string; codes: string[] }
        | undefined

      return document({
        title: 'Two-factor',
        payload: {
          enabled: user()?.twoFactorEnabled === true,
          pending,
          turnedOn: query.on === '1',
          turnedOff: query.off === '1',
          error: errors().first('two-factor')
        }
      })
    },
    middleware('auth', 'password.confirm')
  )

  .get(
    '/settings/passkeys',
    async ({ request, query }) =>
      document({
        title: 'Passkeys',
        payload: {
          passkeys: passkeyRows(
            (await api().listPasskeys({ headers: request.headers })) as unknown
          ),
          removed: query.removed === '1',
          error: errors().first('passkey')
        }
      }),
    middleware('auth', 'password.confirm')
  )

  .get(
    '/settings/security',
    async ({ request, query }) => {
      const listed = (await api().listSessions({ headers: request.headers })) as unknown

      return document({
        title: 'Security',
        payload: {
          sessions: sessionSummaries(listed, request.headers),
          revoked: query.revoked === '1',
          error: errors().first('session')
        }
      })
    },
    middleware('auth', 'password.confirm')
  )
