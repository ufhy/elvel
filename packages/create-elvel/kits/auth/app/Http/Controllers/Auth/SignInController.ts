import { api, messageFrom, withSession } from '@elvel/auth'
import { controller } from '@elvel/core'
import { currentScope, errors, middleware, redirect, routes } from '@elvel/http'
import { view } from '@elvel/view'
import { t } from 'elysia'
import { SignIn } from '../../../../resources/views/pages/auth/sign-in.tsx'

/**
 * Signing in, and signing out again.
 *
 * The form posts here rather than to better-auth's own endpoint, and the handler
 * calls its **server API**. better-auth answers with JSON and the session cookie
 * on it; what goes back to the browser is a redirect carrying that cookie. That
 * is the whole trick, and it is what keeps this a plain HTML application: no
 * token to store, no fetch wrapper to keep in step.
 */
routes().names({ login: '/sign-in' })

export default controller('auth-sign-in')
  .get(
    '/sign-in',
    () => view(SignIn, { title: 'Sign in', error: errors().first('email') }),
    middleware('guest')
  )

  .post(
    '/sign-in',
    async ({ body, request }) => {
      const answer = await api().signInEmail({
        body: { email: body.email, password: body.password },
        /**
         * The headers are what make the security page worth having.
         *
         * better-auth records the user agent and IP from whatever request it is
         * handed. Called without them it stores empty strings, and every row on
         * `/settings/security` reads "Unknown browser" — a list of dates nobody
         * can act on.
         */
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/sign-in')
          .withErrors({ email: await messageFrom(answer, 'Those details did not match.') })
          .withInput({ email: body.email })
          .toResponse()
      }

      /**
       * A 200 that is not a sign-in.
       *
       * With two-factor enabled on the account, better-auth answers
       * `{ twoFactorRedirect: true }` — no session, and a short-lived
       * `better-auth.two_factor` cookie instead. `withSession` copies every
       * cookie it set, which matters here: the answer *clears* the session
       * cookies and sets the two-factor one, and dropping any of the three
       * leaves somebody stuck on a challenge page that cannot identify them.
       */
      if (((await answer.clone().json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect) {
        return withSession(answer, await redirect('/two-factor-challenge').seeOther().toResponse())
      }

      /**
       * A new session id, now that this browser is somebody.
       *
       * Session fixation: an id chosen before signing in is an id somebody else
       * may have chosen, and if it still names the session afterwards then whoever
       * chose it is signed in as this user. The CSRF token rotates with it, so a
       * token picked up while signed out no longer authorises writes while signed
       * in. Laravel calls this in the same place, for the same reason.
       */
      await currentScope()?.session.regenerate()

      return withSession(answer, await redirect('/dashboard').seeOther().toResponse())
    },
    {
      ...middleware('guest', 'throttle:6,1'),
      body: t.Object({ email: t.String(), password: t.String() })
    }
  )

  .post('/sign-out', async ({ request }) => {
    const answer = await api().signOut({ headers: request.headers, asResponse: true })

    // The response carries an expired cookie; without copying it across, the
    // browser keeps the session and "sign out" does nothing.
    return withSession(answer, await redirect('/').seeOther().toResponse())
  })
