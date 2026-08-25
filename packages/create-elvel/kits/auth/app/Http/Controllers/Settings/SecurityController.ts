import { api, sessionSummaries, withSession } from '@elvel/auth'
import { errors, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { Security } from '../../../../resources/views/pages/settings/security.tsx'

/**
 * Where this account is signed in, and how to end those sessions.
 *
 * `routes/settings.ts` puts all three behind the password-confirmation window as
 * well as `auth`: revoking sessions is what somebody does when they think an
 * account is compromised, and it is also what an attacker with a borrowed browser
 * would do to keep it. Reading which devices are signed in is the same story.
 */
export default class SecurityController {
  async show({ request, query }: { request: Request; query: Record<string, string | undefined> }) {
    const listed = (await api().listSessions({ headers: request.headers })) as unknown

    return view(Security, {
      title: 'Security',
      sessions: sessionSummaries(listed, request.headers),
      revoked: query.revoked === '1',
      error: errors().first('session')
    })
  }

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
