import { api, confirmPassword, messageFrom } from '@elvel/auth'
import { config } from '@elvel/core'
import { intended, redirect } from '@elvel/http'

/**
 * This kit's own copy, with the page removed.
 *
 * The auth layer's version of this class renders a screen *and* performs the
 * action, so it imports its `.tsx` page at the top of the module — and that import
 * is evaluated the moment a routes file mentions the class, whether or not the
 * page method is ever routed. This kit renders its screens in Vue, so carrying
 * that layer's file meant carrying an empty `.tsx` beside it purely to satisfy an
 * import. Measured: delete the page and the application dies at load.
 *
 * So the actions live here instead, copied verbatim, and nothing in this kit
 * imports a page it does not render. The cost is a copy: an action fixed in the
 * auth kit has to be fixed here too.
 */
/**
 * The window that guards the dangerous pages.
 *
 * Signing in is not the same as being at the keyboard now. Asking for the
 * password again opens a short window — `confirmPassword` holds it — and the
 * pages that can end a session or close an account sit behind it.
 */
export default class ConfirmPasswordController {
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
