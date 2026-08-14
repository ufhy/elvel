import { auth } from '@elysian/auth'
import { controller } from '@elysian/core'
import { errors, redirect, throttle } from '@elysian/http'
import { view } from '@elysian/view'
import { Elysia, t } from 'elysia'
import { Dashboard } from '../../../resources/views/pages/dashboard.tsx'
import { ForgotPassword } from '../../../resources/views/pages/forgot-password.tsx'
import { ResetPassword } from '../../../resources/views/pages/reset-password.tsx'
import { Password } from '../../../resources/views/pages/settings/password.tsx'
import { Profile } from '../../../resources/views/pages/settings/profile.tsx'
import { Security, type SessionRow } from '../../../resources/views/pages/settings/security.tsx'
import { SignIn } from '../../../resources/views/pages/sign-in.tsx'
import { SignUp } from '../../../resources/views/pages/sign-up.tsx'
import { VerifyEmail } from '../../../resources/views/pages/verify-email.tsx'

/**
 * better-auth's server API, which the framework types only as far as it uses.
 *
 * Widened here rather than in the package: an application reaches for whichever
 * endpoints its own plugins add, and a type that tried to list them would be
 * wrong for every application but one.
 */
type ServerApi = {
  signInEmail(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  signUpEmail(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  signOut(args: { headers: Headers; asResponse: true }): Promise<Response>
  requestPasswordReset(args: { body: unknown; asResponse: true }): Promise<Response>
  resetPassword(args: { body: unknown; asResponse: true }): Promise<Response>
  changePassword(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  updateUser(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  deleteUser(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  sendVerificationEmail(args: { body: unknown; asResponse: true }): Promise<Response>
  listSessions(args: { headers: Headers }): Promise<unknown>
  revokeSession(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  revokeOtherSessions(args: { headers: Headers; asResponse: true }): Promise<Response>
}

const api = () => auth().instance.api as unknown as ServerApi

/**
 * Already signed in? Then these pages are not for you.
 *
 * Fortify puts `guest:` middleware on login, register, forgot-password and
 * reset-password for the same reason: a signed-in person landing on a sign-in
 * form either signs in as themselves again for no reason, or is confused about
 * which account they are using.
 */
function ifGuest(user: unknown, page: () => Response | Promise<Response> | unknown) {
  return user ? redirect('/dashboard').toResponse() : page()
}

/**
 * The routes that accept a credential or send an email, rate limited together.
 *
 * A separate plugin rather than a `use()` on the whole controller, because
 * `throttle()` is scoped to the plugin it sits in and the GET pages have no
 * business sharing a budget with the POSTs.
 *
 * Fortify's own limits are the model: the starter kit turns the `login` limiter
 * on, and verification is throttled at six a minute whether you ask for it or
 * not. Without this, `/sign-in` is a credential-stuffing endpoint and
 * `/forgot-password` is a way to post mail to somebody else's inbox all day.
 */
const credentials = new Elysia({ name: 'auth-pages:credentials' }).use(
  throttle({ max: 6, decay: 60, prefix: 'auth-credentials' })
)

/**
 * Sign in, sign up, sign out — server-rendered, no client JavaScript.
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
  .get('/sign-in', ({ user }) =>
    ifGuest(user, () => view(SignIn, { title: 'Sign in', error: errors().first('email') }))
  )

  .get('/sign-up', ({ user }) =>
    ifGuest(user, () =>
      view(SignUp, { title: 'Create an account', error: errors().first('email') })
    )
  )

  .get('/dashboard', ({ user }) => {
    // `user` is resolved by the auth plugin; `guest()` remembers where we were
    // going so signing in returns here rather than to the landing page.
    if (!user) return redirect('/sign-in').guest().toResponse()

    return view(Dashboard, { title: 'Dashboard', name: user.name ?? user.email })
  })

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
    { body: t.Object({ email: t.String(), password: t.String() }) }
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
    { body: t.Object({ name: t.String(), email: t.String(), password: t.String() }) }
  )

  // ------------------------------------------------------ forgotten password

  .get('/forgot-password', ({ query, user }) =>
    ifGuest(user, () =>
      view(ForgotPassword, {
        title: 'Reset your password',
        error: errors().first('email'),
        sent: query.sent === '1'
      })
    )
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
    { body: t.Object({ email: t.String() }) }
  )

  .get('/reset-password', ({ query, user }) =>
    ifGuest(user, () => {
      // better-auth appends the token to `redirectTo`; without one there is
      // nothing to reset and the form would post an empty token.
      if (!query.token) return redirect('/forgot-password').toResponse()

      return view(ResetPassword, {
        title: 'Choose a new password',
        token: query.token,
        error: errors().first('password')
      })
    })
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
      body: t.Object({
        token: t.String(),
        password: t.String(),
        password_confirmation: t.String()
      })
    }
  )

  // -------------------------------------------------------- email verification

  .get('/verify-email', ({ user, query }) => {
    if (!user) return redirect('/sign-in').guest().toResponse()

    return view(VerifyEmail, {
      title: 'Confirm your address',
      email: user.email,
      sent: query.sent === '1',
      error: errors().first('email')
    })
  })

  .post('/verify-email/resend', async ({ user }) => {
    if (!user) return redirect('/sign-in').guest().toResponse()

    await api().sendVerificationEmail({
      body: { email: user.email, callbackURL: '/dashboard' },
      asResponse: true
    })

    return redirect('/verify-email?sent=1').seeOther().toResponse()
  })

  // ------------------------------------------------------------------ profile

  .get('/settings/profile', ({ user, query }) => {
    if (!user) return redirect('/sign-in').guest().toResponse()

    return view(Profile, {
      title: 'Profile',
      name: user.name ?? '',
      email: user.email,
      emailVerified: user.emailVerified === true,
      saved: query.saved === '1',
      error: errors().first('name') ?? errors().first('email')
    })
  })

  .post(
    '/settings/profile',
    async ({ body, request, user }) => {
      if (!user) return redirect('/sign-in').guest().toResponse()

      const answer = await api().updateUser({
        // `email` is sent only when it changed: better-auth restarts
        // verification for a new address, and resending the same one would
        // unverify an account that was already confirmed.
        body:
          body.email === user.email ? { name: body.name } : { name: body.name, email: body.email },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/settings/profile')
          .withErrors({ email: await messageFrom(answer, 'That could not be saved.') })
          .withInput({ name: body.name, email: body.email })
          .toResponse()
      }

      return withSession(
        answer,
        await redirect('/settings/profile?saved=1').seeOther().toResponse()
      )
    },
    { body: t.Object({ name: t.String(), email: t.String() }) }
  )

  .post(
    '/settings/profile/delete',
    async ({ body, request, user }) => {
      if (!user) return redirect('/sign-in').guest().toResponse()

      const answer = await api().deleteUser({
        body: { password: body.password },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/settings/profile')
          .withErrors({ name: await messageFrom(answer, 'That password was wrong.') })
          .toResponse()
      }

      return withSession(answer, await redirect('/').seeOther().toResponse())
    },
    { body: t.Object({ password: t.String() }) }
  )

  // ----------------------------------------------------------------- password

  .get('/settings/password', ({ user, query }) => {
    if (!user) return redirect('/sign-in').guest().toResponse()

    return view(Password, {
      title: 'Password',
      saved: query.saved === '1',
      error: errors().first('password')
    })
  })

  .post(
    '/settings/password',
    async ({ body, request, user }) => {
      if (!user) return redirect('/sign-in').guest().toResponse()

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

      return withSession(
        answer,
        await redirect('/settings/password?saved=1').seeOther().toResponse()
      )
    },
    {
      body: t.Object({
        current: t.String(),
        password: t.String(),
        password_confirmation: t.String()
      })
    }
  )

  // ----------------------------------------------------------------- security

  .get('/settings/security', async ({ request, user, query }) => {
    if (!user) return redirect('/sign-in').guest().toResponse()

    const listed = (await api().listSessions({ headers: request.headers })) as unknown

    return view(Security, {
      title: 'Security',
      sessions: sessionRows(listed, request.headers),
      revoked: query.revoked === '1',
      error: errors().first('session')
    })
  })

  .post(
    '/settings/security/revoke',
    async ({ body, request, user }) => {
      if (!user) return redirect('/sign-in').guest().toResponse()

      await api().revokeSession({
        body: { token: body.id },
        headers: request.headers,
        asResponse: true
      })

      return redirect('/settings/security?revoked=1').seeOther().toResponse()
    },
    { body: t.Object({ id: t.String() }) }
  )

  .post('/settings/security/revoke-others', async ({ request, user }) => {
    if (!user) return redirect('/sign-in').guest().toResponse()

    const answer = await api().revokeOtherSessions({
      headers: request.headers,
      asResponse: true
    })

    return withSession(
      answer,
      await redirect('/settings/security?revoked=1').seeOther().toResponse()
    )
  })

  .post('/sign-out', async ({ request }) => {
    const answer = await api().signOut({ headers: request.headers, asResponse: true })

    // The response carries an expired cookie; without copying it across, the
    // browser keeps the session and "sign out" does nothing.
    return withSession(answer, await redirect('/').seeOther().toResponse())
  })

/** Move better-auth's `Set-Cookie` headers onto the response we are sending. */
function withSession(from: Response, to: Response): Response {
  const headers = new Headers(to.headers)

  for (const cookie of from.headers.getSetCookie()) headers.append('set-cookie', cookie)

  return new Response(to.body, { status: to.status, headers })
}

/**
 * What better-auth said, when it said anything useful.
 *
 * Anything else becomes the generic line: the detail of why a sign-in failed
 * tells an attacker more than it tells the person typing.
 */
async function messageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string }

    return typeof body.message === 'string' ? body.message : fallback
  } catch {
    return fallback
  }
}

/**
 * better-auth's session list, as rows the page can render.
 *
 * Which row is *this* browser is decided by comparing the session token in the
 * request's own cookie, because the list itself does not say. Marking the wrong
 * row current would offer somebody a "sign it out" button that logs them out of
 * the browser they are reading it in.
 */
function sessionRows(listed: unknown, headers: Headers): SessionRow[] {
  const rows = Array.isArray(listed) ? listed : []
  const cookie = headers.get('cookie') ?? ''

  return rows.map((row) => {
    const session = row as Record<string, unknown>
    const token = String(session.token ?? session.id ?? '')

    return {
      id: token,
      // The cookie holds the token, sometimes with a signature after a dot.
      current: token !== '' && cookie.includes(token),
      createdAt: asText(session.createdAt),
      expiresAt: asText(session.expiresAt),
      userAgent: asText(session.userAgent),
      ipAddress: asText(session.ipAddress)
    }
  })
}

function asText(value: unknown): string | undefined {
  // An empty string is what better-auth stores when it was never told, and `??`
  // would keep it — leaving a row with no browser name and no fallback either.
  if (value === null || value === undefined || value === '') return undefined
  if (value instanceof Date) return value.toISOString().slice(0, 16).replace('T', ' ')

  return String(value)
}
