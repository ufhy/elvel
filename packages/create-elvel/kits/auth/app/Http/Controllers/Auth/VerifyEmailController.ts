import { api, userOf } from '@elvel/auth'
import { errors, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { VerifyEmail } from '../../../../resources/views/pages/auth/verify-email.tsx'

/**
 * Confirming an address.
 *
 * Separate from signing in because it happens *after*: the account exists and
 * the session is real, and what is missing is proof that somebody reads the
 * inbox. `verified` middleware is what keeps a page behind that proof.
 */
export default class VerifyEmailController {
  notice(context: { query: Record<string, string | undefined> }) {
    const { query } = context

    return view(VerifyEmail, {
      title: 'Confirm your address',
      email: userOf(context as never).email,
      sent: query.sent === '1',
      error: errors().first('email')
    })
  }

  async resend(context: object) {
    await api().sendVerificationEmail({
      body: { email: userOf(context as never).email, callbackURL: '/dashboard' },
      asResponse: true
    })

    return redirect('/verify-email?sent=1').seeOther().toResponse()
  }
}
