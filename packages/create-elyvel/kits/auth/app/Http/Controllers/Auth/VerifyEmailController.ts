import { api, userOf } from '@elyvel/auth'
import { controller } from '@elyvel/core'
import { errors, middleware, redirect } from '@elyvel/http'
import { view } from '@elyvel/view'
import { VerifyEmail } from '../../../../resources/views/pages/auth/verify-email.tsx'

/**
 * Confirming an address.
 *
 * Separate from signing in because it happens *after*: the account exists and
 * the session is real, and what is missing is proof that somebody reads the
 * inbox. `verified` middleware is what keeps a page behind that proof.
 */
export default controller('verify-email')
  .get(
    '/verify-email',
    (context) => {
      const { query } = context

      return view(VerifyEmail, {
        title: 'Confirm your address',
        email: userOf(context).email,
        sent: query.sent === '1',
        error: errors().first('email')
      })
    },
    middleware('auth')
  )

  .post(
    '/verify-email/resend',
    async (context) => {
      await api().sendVerificationEmail({
        body: { email: userOf(context).email, callbackURL: '/dashboard' },
        asResponse: true
      })

      return redirect('/verify-email?sent=1').seeOther().toResponse()
    },
    middleware('auth', 'throttle:6,1')
  )

// ------------------------------------------------------------------ profile
