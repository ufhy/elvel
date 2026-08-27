import { api, messageFrom, withSession } from '@elvel/auth'
import { redirect } from '@elvel/http'

type Change = { current: string; password: string; password_confirmation: string }

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
 * Changing the password.
 *
 * The current one is asked for, which is the point: a borrowed unlocked browser
 * should not be able to lock its owner out. better-auth issues a fresh session
 * on success and the new cookie is copied across, or the person is signed out by
 * the very act of changing it.
 */
export default class PasswordController {
  async update({ body, request }: { body: Change; request: Request }) {
    if (body.password !== body.password_confirmation) {
      return redirect('/settings/password')
        .withErrors({ password: 'The two passwords do not match.' })
        .toResponse()
    }

    const answer = await api().changePassword({
      // Every other session goes: a password change is usually a response to
      // somebody else having had access.
      body: {
        currentPassword: body.current,
        newPassword: body.password,
        revokeOtherSessions: true
      },
      headers: request.headers,
      asResponse: true
    })

    if (!answer.ok) {
      return redirect('/settings/password')
        .withErrors({ password: await messageFrom(answer, 'That current password was wrong.') })
        .toResponse()
    }

    return withSession(answer, await redirect('/settings/password?saved=1').seeOther().toResponse())
  }
}
