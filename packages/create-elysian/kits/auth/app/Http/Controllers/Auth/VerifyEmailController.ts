import { controller } from '@elysian/core'
import { errors, middleware, redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { VerifyEmail } from '../../../../resources/views/pages/auth/verify-email.tsx'
import { account, api } from '../../../Support/auth.ts'

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
        email: account(context).email,
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
        body: { email: account(context).email, callbackURL: '/dashboard' },
        asResponse: true
      })

      return redirect('/verify-email?sent=1').seeOther().toResponse()
    },
    middleware('auth', 'throttle:6,1')
  )

// ------------------------------------------------------------------ profile
