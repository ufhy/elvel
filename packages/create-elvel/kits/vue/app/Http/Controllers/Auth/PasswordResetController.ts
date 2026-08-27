import { api, messageFrom } from '@elvel/auth'
import { config } from '@elvel/core'
import { redirect } from '@elvel/http'

type NewPassword = { token: string; password: string; password_confirmation: string }

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
 * The forgotten-password round trip: ask for a link, then use it.
 *
 * Two pages that only make sense together, and both are open to guests — which
 * is what makes the answer to "is there an account here?" so important. It is
 * the same either way.
 */
export default class PasswordResetController {
  async email({ body }: { body: { email: string } }) {
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
    return redirect(`${config('auth.forgotPasswordRoute', '/forgot-password')}?sent=1`)
      .seeOther()
      .toResponse()
  }

  async update({ body }: { body: NewPassword }) {
    const back = `${config('auth.resetPasswordRoute', '/reset-password')}?token=${encodeURIComponent(body.token)}`

    if (body.password !== body.password_confirmation) {
      return redirect(back).withErrors({ password: 'The two passwords do not match.' }).toResponse()
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
    return redirect(config('auth.redirectGuestsTo', '/sign-in')).seeOther().toResponse()
  }
}
