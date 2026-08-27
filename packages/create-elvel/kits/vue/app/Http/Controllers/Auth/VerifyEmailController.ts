import { api, userOf } from '@elvel/auth'
import { config } from '@elvel/core'
import { redirect } from '@elvel/http'

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
 * Confirming an address.
 *
 * Separate from signing in because it happens *after*: the account exists and
 * the session is real, and what is missing is proof that somebody reads the
 * inbox. `verified` middleware is what keeps a page behind that proof.
 */
export default class VerifyEmailController {
  async resend(context: object) {
    await api().sendVerificationEmail({
      body: { email: userOf(context as never).email, callbackURL: '/dashboard' },
      asResponse: true
    })

    return redirect(`${config('auth.verifyRoute', '/verify-email')}?sent=1`)
      .seeOther()
      .toResponse()
  }
}
