import { controller } from '@elvel/core'
import { middleware, redirect } from '@elvel/http'
import { document } from '@elvel/spa'

/**
 * The auth screens, answered with the shell their own bundle boots from.
 *
 * This kit's whole departure from the auth kit it is built on, in one file. The
 * auth kit's controllers still own every **action** — `POST /sign-in` calls
 * better-auth, rotates the session, copies the cookie — and not one line of them is
 * edited or copied. What this replaces is only the seven **pages**.
 *
 * How: `routes/web.ts` mounts this controller *after* those, and in Elysia the last
 * registration of a path wins. Measured, not assumed. That makes this a deliberate
 * shadow, so it lists the paths it takes over rather than hiding them behind a
 * pattern — a route somebody cannot find the handler for is worse than a list.
 *
 * The guards are repeated from the controllers being shadowed, and have to be:
 * shadowing the handler shadows its middleware too.
 *
 * No payload on any of these. `spa.embed` is off, so the document is a shell and
 * every screen asks for what it needs — which for an auth screen is nothing at all
 * until its form is submitted.
 */

/**
 * The auth screens' own bundle.
 *
 * Their own, so a guest signing in downloads seven forms and not the application
 * behind them. It is the second entry in `frontend/vite.config.ts`.
 */
const AUTH_ENTRY = 'src/auth.ts'

export default controller('vue-auth-pages')
  .get('/sign-in', () => document({ title: 'Sign in', entry: AUTH_ENTRY }), middleware('guest'))

  .get(
    '/sign-up',
    () => document({ title: 'Create an account', entry: AUTH_ENTRY }),
    middleware('guest')
  )

  .get(
    '/forgot-password',
    () => document({ title: 'Reset your password', entry: AUTH_ENTRY }),
    middleware('guest')
  )

  .get(
    '/reset-password',
    ({ query }) => {
      // better-auth appends the token to `redirectTo`; without one there is nothing
      // to reset and the form would post an empty token. The same refusal the auth
      // kit makes — shadowing the page must not shadow the check.
      if (!query.token) return redirect('/forgot-password').toResponse()

      return document({ title: 'Choose a new password', entry: AUTH_ENTRY })
    },
    middleware('guest')
  )

  .get(
    '/two-factor-challenge',
    () => document({ title: 'Two-factor', entry: AUTH_ENTRY }),
    middleware('guest')
  )

  /**
   * Two screens for somebody already signed in, and still on the auth bundle.
   *
   * Both exist to interrupt: one waits for a link in an inbox, the other asks for a
   * password again before anything that would undo the account's security. Neither
   * wants the application's sidebar behind it, and neither needs its bundle.
   */
  .get(
    '/verify-email',
    () => document({ title: 'Confirm your address', entry: AUTH_ENTRY }),
    middleware('auth')
  )

  .get(
    '/confirm-password',
    () => document({ title: 'Confirm password', entry: AUTH_ENTRY }),
    middleware('auth')
  )
