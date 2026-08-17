import { api, sessionSummaries, withSession } from '@elvel/auth'
import { controller } from '@elvel/core'
import { errors, middleware, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { t } from 'elysia'
import { Security } from '../../../../resources/views/pages/settings/security.tsx'

/**
 * Where this account is signed in, and how to end those sessions.
 *
 * Behind the password-confirmation window as well as `auth`: revoking sessions
 * is what somebody does when they think an account is compromised, and it is
 * also what an attacker with a borrowed browser would do to keep it.
 */
export default controller('settings-security')
  .get(
    '/settings/security',
    async ({ request, query }) => {
      const listed = (await api().listSessions({ headers: request.headers })) as unknown

      return view(Security, {
        title: 'Security',
        sessions: sessionSummaries(listed, request.headers),
        revoked: query.revoked === '1',
        error: errors().first('session')
      })
    },
    // Reading which devices are signed in, and cutting any of them off, is the
    // one place a borrowed unlocked browser does real damage — so it asks.
    middleware('auth', 'password.confirm')
  )

  .post(
    '/settings/security/revoke',
    async ({ body, request }) => {
      await api().revokeSession({
        body: { token: body.id },
        headers: request.headers,
        asResponse: true
      })

      return redirect('/settings/security?revoked=1').seeOther().toResponse()
    },
    {
      ...middleware('auth', 'password.confirm'),
      body: t.Object({ id: t.String() })
    }
  )

  .post(
    '/settings/security/revoke-others',
    async ({ request }) => {
      const answer = await api().revokeOtherSessions({
        headers: request.headers,
        asResponse: true
      })

      return withSession(
        answer,
        await redirect('/settings/security?revoked=1').seeOther().toResponse()
      )
    },
    middleware('auth', 'password.confirm')
  )

// --------------------------------------------------- password confirmation
