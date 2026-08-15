import { type AuthUser, auth, confirmPassword, userOf } from '@elysian/auth'
import { controller } from '@elysian/core'
import { errors, intended, middleware, redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { t } from 'elysia'
import { ConfirmPassword } from '../../../resources/views/pages/confirm-password.tsx'
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
  changeEmail(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  verifyPassword(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  deleteUser(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  sendVerificationEmail(args: { body: unknown; asResponse: true }): Promise<Response>
  listSessions(args: { headers: Headers }): Promise<unknown>
  revokeSession(args: { body: unknown; headers: Headers; asResponse: true }): Promise<Response>
  revokeOtherSessions(args: { headers: Headers; asResponse: true }): Promise<Response>
}

const api = () => auth().instance.api as unknown as ServerApi

/**
 * The signed-in user, with the three fields these pages render.
 *
 * `AuthUser` is `{ id } & Record<string, unknown>` on purpose — better-auth's
 * user table is whatever the application's plugins make it, and the framework
 * cannot promise a `name` that a schema may not have. So the narrowing happens
 * here, once, where this kit's own schema is known, rather than with a cast at
 * every call site.
 */
function account(context: unknown): { name: string; email: string; emailVerified: boolean } {
  const user = userOf(context) as AuthUser & {
    name?: unknown
    email?: unknown
    emailVerified?: unknown
  }

  return {
    name: typeof user.name === 'string' ? user.name : '',
    email: typeof user.email === 'string' ? user.email : '',
    emailVerified: user.emailVerified === true
  }
}

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

  .get(
    '/dashboard',
    // `auth` has already sent a guest to sign in, remembering where they were
    // going — so `user` is present here by the time this runs.
    (context) => {
      const person = account(context)

      return view(Dashboard, { title: 'Dashboard', name: person.name || person.email })
    },
    middleware('auth')
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

  .get(
    '/verify-email',
    (context) => {
      const { query } = context

      return view(VerifyEmail, {
        title: 'Confirm your address',
        email: account(context).email,
        sent: query.sent === '1',
        error: errors().first('email')
      })
    },
    middleware('auth')
  )

  .post(
    '/verify-email/resend',
    async (context) => {
      await api().sendVerificationEmail({
        body: { email: account(context).email, callbackURL: '/dashboard' },
        asResponse: true
      })

      return redirect('/verify-email?sent=1').seeOther().toResponse()
    },
    middleware('auth', 'throttle:6,1')
  )

  // ------------------------------------------------------------------ profile

  .get(
    '/settings/profile',
    (context) => {
      const person = account(context)
      const { query } = context

      return view(Profile, {
        title: 'Profile',
        name: person.name,
        email: person.email,
        emailVerified: person.emailVerified,
        pending: query.pending === '1',
        saved: query.saved === '1',
        error: errors().first('name') ?? errors().first('email')
      })
    },
    middleware('auth')
  )

  .patch(
    '/settings/profile',
    async (context) => {
      const { body, request } = context
      const person = account(context)

      /**
       * Two endpoints, because better-auth refuses to do it in one.
       *
       * `updateUser` throws `EMAIL_CAN_NOT_BE_UPDATED` the moment an `email`
       * appears in its body — changing an address goes through `changeEmail`,
       * which knows to re-verify. The first version of this sent both to
       * `updateUser` and answered 400 for anybody who edited their address, while
       * carrying a comment claiming better-auth handled it.
       */
      const named = await api().updateUser({
        body: { name: body.name },
        headers: request.headers,
        asResponse: true
      })

      if (!named.ok) {
        return redirect('/settings/profile')
          .withErrors({ name: await messageFrom(named, 'That could not be saved.') })
          .withInput({ name: body.name, email: body.email })
          .toResponse()
      }

      if (body.email !== person.email) {
        const moved = await api().changeEmail({
          body: { newEmail: body.email, callbackURL: '/settings/profile' },
          headers: request.headers,
          asResponse: true
        })

        if (!moved.ok) {
          return redirect('/settings/profile')
            .withErrors({ email: await messageFrom(moved, 'That address could not be used.') })
            .withInput({ name: body.name, email: body.email })
            .toResponse()
        }

        /**
         * Which of the two things just happened depends on the old address.
         *
         * A confirmed one is only replaced once the new one is confirmed as well,
         * and the confirmation goes to the address on file — so the page says a
         * link is on its way. An unconfirmed one is replaced outright, and telling
         * somebody to wait for a link that changes nothing would be a lie the next
         * page load exposes.
         */
        const where = person.emailVerified ? 'pending=1' : 'saved=1'

        return withSession(
          named,
          await redirect(`/settings/profile?${where}`).seeOther().toResponse()
        )
      }

      return withSession(named, await redirect('/settings/profile?saved=1').seeOther().toResponse())
    },
    {
      ...middleware('auth'),
      body: t.Object({ name: t.String(), email: t.String() })
    }
  )

  .delete(
    '/settings/profile',
    async ({ body, request }) => {
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
    {
      ...middleware('auth'),
      body: t.Object({ password: t.String() })
    }
  )

  // ----------------------------------------------------------------- password

  .get(
    '/settings/password',
    ({ query }) => {
      return view(Password, {
        title: 'Password',
        saved: query.saved === '1',
        error: errors().first('password')
      })
    },
    middleware('auth')
  )

  .put(
    '/settings/password',
    async ({ body, request }) => {
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
      // Fortify throttles this one at six a minute too: a change form that takes
      // the current password is a place to guess it.
      ...middleware('auth', 'throttle:6,1'),
      body: t.Object({
        current: t.String(),
        password: t.String(),
        password_confirmation: t.String()
      })
    }
  )

  // ----------------------------------------------------------------- security

  .get(
    '/settings/security',
    async ({ request, query }) => {
      const listed = (await api().listSessions({ headers: request.headers })) as unknown

      return view(Security, {
        title: 'Security',
        sessions: sessionRows(listed, request.headers),
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

  .get(
    '/confirm-password',
    () => view(ConfirmPassword, { title: 'Confirm password', error: errors().first('password') }),
    middleware('auth')
  )

  .post(
    '/confirm-password',
    async (context) => {
      const { body, request } = context

      /**
       * `verifyPassword` rather than a sign-in.
       *
       * Signing in again would mint a second session and rotate the cookie, which
       * turns "prove you are there" into "start over" — and on a wrong answer it
       * would count against the sign-in throttle instead of this one.
       */
      const answer = await api().verifyPassword({
        body: { password: body.password },
        // `asResponse`, because a wrong password is an APIError thrown rather than
        // a `{ status: false }` returned — unhandled, the form answers 500 and the
        // person who mistyped is told the server broke.
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/confirm-password')
          .withErrors({ password: await messageFrom(answer, 'That password was wrong.') })
          .toResponse()
      }

      confirmPassword(context)

      // Back where they were headed when the wall came up; `guest()` put it in the
      // session and this pulls it out, so a second visit falls back to settings.
      return intended('/settings/security', 303).toResponse()
    },
    {
      // The same six a minute the sign-in form gets: this form takes a password
      // and answers whether it was right, which is a guessing oracle without it.
      ...middleware('auth', 'throttle:6,1'),
      body: t.Object({ password: t.String() })
    }
  )

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
