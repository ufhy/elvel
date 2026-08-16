import { controller } from '@elysian/core'
import { errors, middleware, redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { t } from 'elysia'
import { ForgotPassword } from '../../../resources/views/pages/forgot-password.tsx'
import { ResetPassword } from '../../../resources/views/pages/reset-password.tsx'
import { SignIn } from '../../../resources/views/pages/sign-in.tsx'
import { SignUp } from '../../../resources/views/pages/sign-up.tsx'
import { api, messageFrom, withSession } from '../../Support/auth.ts'

/**
 * Getting in and getting out: sign in, sign up, sign out, and the forgotten
 * password round trip.
 *
 * The forms post here rather than to better-auth's own endpoints, and the
 * handlers call its **server API**. better-auth answers with JSON and the
 * session cookie on it; what goes back to the browser is a redirect carrying
 * that cookie. That is the whole trick, and it is what keeps this a plain HTML
 * application: no token to store, no fetch wrapper to keep in step.
 *
 * A failure comes back to the form with its message through the session, the
 * same way a validation failure does anywhere else.
 */
export default controller('auth-pages')
  .get(
    '/sign-in',
    () => view(SignIn, { title: 'Sign in', error: errors().first('email') }),
    middleware('guest')
  )

  .get(
    '/sign-up',
    () => view(SignUp, { title: 'Create an account', error: errors().first('email') }),
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

  .post(
    '/sign-up',
    async ({ body, request }) => {
      const answer = await api().signUpEmail({
        body: { name: body.name, email: body.email, password: body.password },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/sign-up')
          .withErrors({ email: await messageFrom(answer, 'That account could not be created.') })
          .withInput({ name: body.name, email: body.email })
          .toResponse()
      }

      // Signing up signs you in, so the cookie travels the same way.
      return withSession(answer, await redirect('/dashboard').seeOther().toResponse())
    },
    {
      ...middleware('guest', 'throttle:6,1'),
      body: t.Object({ name: t.String(), email: t.String(), password: t.String() })
    }
  )

  // ------------------------------------------------------ forgotten password

  .get(
    '/forgot-password',
    ({ query }) =>
      view(ForgotPassword, {
        title: 'Reset your password',
        error: errors().first('email'),
        sent: query.sent === '1'
      }),
    middleware('guest')
  )

  .post(
    '/forgot-password',
    async ({ body }) => {
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
      return redirect('/forgot-password?sent=1').seeOther().toResponse()
    },
    {
      ...middleware('guest', 'throttle:6,1'),
      body: t.Object({ email: t.String() })
    }
  )

  .get(
    '/reset-password',
    ({ query }) => {
      // better-auth appends the token to `redirectTo`; without one there is
      // nothing to reset and the form would post an empty token.
      if (!query.token) return redirect('/forgot-password').toResponse()

      return view(ResetPassword, {
        title: 'Choose a new password',
        token: query.token,
        error: errors().first('password')
      })
    },
    middleware('guest')
  )

  .post(
    '/reset-password',
    async ({ body }) => {
      const back = `/reset-password?token=${encodeURIComponent(body.token)}`

      if (body.password !== body.password_confirmation) {
        return redirect(back)
          .withErrors({ password: 'The two passwords do not match.' })
          .toResponse()
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
      return redirect('/sign-in').seeOther().toResponse()
    },
    {
      ...middleware('guest', 'throttle:6,1'),
      body: t.Object({
        token: t.String(),
        password: t.String(),
        password_confirmation: t.String()
      })
    }
  )

  // -------------------------------------------------------- email verification

  .post('/sign-out', async ({ request }) => {
    const answer = await api().signOut({ headers: request.headers, asResponse: true })

    // The response carries an expired cookie; without copying it across, the
    // browser keeps the session and "sign out" does nothing.
    return withSession(answer, await redirect('/').seeOther().toResponse())
  })
