import { userOf } from '@elvel/auth'
import { controller } from '@elvel/core'
import { errors, middleware, redirect } from '@elvel/http'
import { document } from '@elvel/spa'

/**
 * The auth screens, answered with the document the Vue client boots from.
 *
 * This kit's whole departure from the auth kit it is built on, in one file. The
 * auth kit's controllers still own every **action** — `POST /sign-in` calls
 * better-auth, rotates the session, copies the cookie — and not one line of them
 * is edited or copied. What this replaces is only the seven **pages**.
 *
 * How the replacement happens: `routes/web.ts` mounts this controller *after*
 * those, and in Elysia the last registration of a path wins. Measured, not
 * assumed. That makes this file a deliberate shadow, so it lists the paths it
 * takes over rather than hiding them behind a pattern — a route somebody cannot
 * find the handler for is worse than a list.
 *
 * The guards are repeated from the controllers being shadowed, and have to be:
 * shadowing the handler shadows its middleware too. `guest` on the pages a signed
 * in visitor should never see, `auth` on the two that interrupt somebody who is
 * already in.
 *
 * Each page's data goes in the payload, so the first paint has it — there is no
 * request between the document arriving and the form being usable.
 */
export default controller('vue-auth-pages')
  .get(
    '/sign-in',
    () => document({ title: 'Sign in', payload: { error: errors().first('email') } }),
    middleware('guest')
  )

  .get(
    '/sign-up',
    () => document({ title: 'Create an account', payload: { error: errors().first('email') } }),
    middleware('guest')
  )

  .get(
    '/forgot-password',
    ({ query }) =>
      document({
        title: 'Reset your password',
        payload: { error: errors().first('email'), sent: query.sent === '1' }
      }),
    middleware('guest')
  )

  .get(
    '/reset-password',
    ({ query }) => {
      // better-auth appends the token to `redirectTo`; without one there is nothing
      // to reset and the form would post an empty token. The same refusal the auth
      // kit makes — shadowing the page must not shadow the check.
      if (!query.token) return redirect('/forgot-password').toResponse()

      return document({
        title: 'Choose a new password',
        payload: { token: query.token, error: errors().first('password') }
      })
    },
    middleware('guest')
  )

  .get(
    '/two-factor-challenge',
    () => document({ title: 'Two-factor', payload: { error: errors().first('code') } }),
    middleware('guest')
  )

  .get(
    '/verify-email',
    (context) =>
      document({
        title: 'Confirm your address',
        payload: {
          email: userOf(context).email,
          sent: context.query.sent === '1',
          error: errors().first('email')
        }
      }),
    middleware('auth')
  )

  .get(
    '/confirm-password',
    () => document({ title: 'Confirm password', payload: { error: errors().first('password') } }),
    middleware('auth')
  )
