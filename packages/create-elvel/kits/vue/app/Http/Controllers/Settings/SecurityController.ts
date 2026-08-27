import { api, withSession } from '@elvel/auth'
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
 * Where this account is signed in, and how to end those sessions.
 *
 * `routes/settings.ts` puts all three behind the password-confirmation window as
 * well as `auth`: revoking sessions is what somebody does when they think an
 * account is compromised, and it is also what an attacker with a borrowed browser
 * would do to keep it. Reading which devices are signed in is the same story.
 */
export default class SecurityController {
  async revoke({ body, request }: { body: { id: string }; request: Request }) {
    await api().revokeSession({
      body: { token: body.id },
      headers: request.headers,
      asResponse: true
    })

    return redirect('/settings/security?revoked=1').seeOther().toResponse()
  }

  async revokeOthers({ request }: { request: Request }) {
    const answer = await api().revokeOtherSessions({
      headers: request.headers,
      asResponse: true
    })

    return withSession(
      answer,
      await redirect('/settings/security?revoked=1').seeOther().toResponse()
    )
  }
}
