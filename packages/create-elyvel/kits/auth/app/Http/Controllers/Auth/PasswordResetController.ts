import { api, messageFrom } from '@elyvel/auth'
import { controller } from '@elyvel/core'
import { errors, middleware, redirect } from '@elyvel/http'
import { view } from '@elyvel/view'
import { t } from 'elysia'
import { ForgotPassword } from '../../../../resources/views/pages/auth/forgot-password.tsx'
import { ResetPassword } from '../../../../resources/views/pages/auth/reset-password.tsx'

/**
 * The forgotten-password round trip: ask for a link, then use it.
 *
 * Two pages that only make sense together, and both are open to guests — which
 * is what makes the answer to "is there an account here?" so important. It is
 * the same either way.
 */
export default controller('auth-password-reset')
  .get(
    '/forgot-password',
    ({ query }) =>
      view(ForgotPassword, {
        title: 'Reset your password',
        error: errors().first('email'),
        sent: query.sent === '1'
      }),
    middleware('guest')
  )

  .post(
    '/forgot-password',
    async ({ body }) => {
      await api().requestPasswordReset({
        body: { email: body.email, redirectTo: '/reset-password' },
        asResponse: true
      })

      /**
       * The answer is the same either way, and the failure is ignored on
       * purpose.
       *
       * Reporting "no account with that email" turns this form into a way to
       * ask whether somebody banks here — useful to nobody but the person
       * phishing them.
       */
      return redirect('/forgot-password?sent=1').seeOther().toResponse()
    },
    {
      ...middleware('guest', 'throttle:6,1'),
      body: t.Object({ email: t.String() })
    }
  )

  .get(
    '/reset-password',
    ({ query }) => {
      // better-auth appends the token to `redirectTo`; without one there is
      // nothing to reset and the form would post an empty token.
      if (!query.token) return redirect('/forgot-password').toResponse()

      return view(ResetPassword, {
        title: 'Choose a new password',
        token: query.token,
        error: errors().first('password')
      })
    },
    middleware('guest')
  )

  .post(
    '/reset-password',
    async ({ body }) => {
      const back = `/reset-password?token=${encodeURIComponent(body.token)}`

      if (body.password !== body.password_confirmation) {
        return redirect(back)
          .withErrors({ password: 'The two passwords do not match.' })
          .toResponse()
      }

      const answer = await api().resetPassword({
        body: { newPassword: body.password, token: body.token },
        asResponse: true
      })

      if (!answer.ok) {
        return redirect(back)
          .withErrors({
            password: await messageFrom(answer, 'That link has expired. Ask for another.')
          })
          .toResponse()
      }

      // Deliberately not signed in afterwards: whoever used the link proved they
      // read the inbox, not that they are the account's owner.
      return redirect('/sign-in').seeOther().toResponse()
    },
    {
      ...middleware('guest', 'throttle:6,1'),
      body: t.Object({
        token: t.String(),
        password: t.String(),
        password_confirmation: t.String()
      })
    }
  )

// -------------------------------------------------------- email verification
