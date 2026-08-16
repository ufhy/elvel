import { messageFrom, withSession } from '@elysian/auth'
import { controller } from '@elysian/core'
import { errors, middleware, redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { t } from 'elysia'
import { SignIn } from '../../../../resources/views/pages/auth/sign-in.tsx'
import { api } from '../../../Support/auth.ts'

/**
 * Signing in, and signing out again.
 *
 * The form posts here rather than to better-auth's own endpoint, and the handler
 * calls its **server API**. better-auth answers with JSON and the session cookie
 * on it; what goes back to the browser is a redirect carrying that cookie. That
 * is the whole trick, and it is what keeps this a plain HTML application: no
 * token to store, no fetch wrapper to keep in step.
 */
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
