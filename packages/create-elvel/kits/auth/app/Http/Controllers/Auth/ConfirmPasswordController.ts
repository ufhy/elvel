import { api, confirmPassword, messageFrom } from '@elvel/auth'
import { config } from '@elvel/core'
import { errors, intended, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { ConfirmPassword } from '../../../../resources/views/pages/auth/confirm-password.tsx'

/**
 * The window that guards the dangerous pages.
 *
 * Signing in is not the same as being at the keyboard now. Asking for the
 * password again opens a short window — `confirmPassword` holds it — and the
 * pages that can end a session or close an account sit behind it.
 */
export default class ConfirmPasswordController {
  show() {
    return view(ConfirmPassword, { title: 'Confirm password', error: errors().first() })
  }

  async store(context: { body: { password: string }; request: Request }) {
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
      return redirect(config('auth.passwordConfirmRoute', '/confirm-password'))
        .withErrors({ password: await messageFrom(answer, 'That password was wrong.') })
        .toResponse()
    }

    confirmPassword(context as never)

    // Back where they were headed when the wall came up; `guest()` put it in the
    // session and this pulls it out, so a second visit falls back to settings.
    return intended('/settings/security', 303).toResponse()
  }
}
