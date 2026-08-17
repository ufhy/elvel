import { api, confirmPassword, messageFrom } from '@elyvel/auth'
import { controller } from '@elyvel/core'
import { errors, intended, middleware, redirect } from '@elyvel/http'
import { view } from '@elyvel/view'
import { t } from 'elysia'
import { ConfirmPassword } from '../../../../resources/views/pages/auth/confirm-password.tsx'

/**
 * The window that guards the dangerous pages.
 *
 * Signing in is not the same as being at the keyboard now. Asking for the
 * password again opens a short window — `confirmPassword` holds it — and the
 * pages that can end a session or close an account sit behind it.
 */
export default controller('confirm-password')
  .get(
    '/confirm-password',
    () => view(ConfirmPassword, { title: 'Confirm password', error: errors().first('password') }),
    middleware('auth')
  )

  .post(
    '/confirm-password',
    async (context) => {
      const { body, request } = context

      /**
       * `verifyPassword` rather than a sign-in.
       *
       * Signing in again would mint a second session and rotate the cookie, which
       * turns "prove you are there" into "start over" — and on a wrong answer it
       * would count against the sign-in throttle instead of this one.
       */
      const answer = await api().verifyPassword({
        body: { password: body.password },
        // `asResponse`, because a wrong password is an APIError thrown rather than
        // a `{ status: false }` returned — unhandled, the form answers 500 and the
        // person who mistyped is told the server broke.
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/confirm-password')
          .withErrors({ password: await messageFrom(answer, 'That password was wrong.') })
          .toResponse()
      }

      confirmPassword(context)

      // Back where they were headed when the wall came up; `guest()` put it in the
      // session and this pulls it out, so a second visit falls back to settings.
      return intended('/settings/security', 303).toResponse()
    },
    {
      // The same six a minute the sign-in form gets: this form takes a password
      // and answers whether it was right, which is a guessing oracle without it.
      ...middleware('auth', 'throttle:6,1'),
      body: t.Object({ password: t.String() })
    }
  )
