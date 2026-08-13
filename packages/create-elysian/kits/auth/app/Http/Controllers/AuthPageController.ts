import { auth } from '@elysian/auth'
import { controller } from '@elysian/core'
import { errors, redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { t } from 'elysia'
import { Dashboard } from '../../../resources/views/pages/dashboard.tsx'
import { SignIn } from '../../../resources/views/pages/sign-in.tsx'
import { SignUp } from '../../../resources/views/pages/sign-up.tsx'

/**
 * better-auth's server API, which the framework types only as far as it uses.
 *
 * Widened here rather than in the package: an application reaches for whichever
 * endpoints its own plugins add, and a type that tried to list them would be
 * wrong for every application but one.
 */
type ServerApi = {
  signInEmail(args: { body: unknown; asResponse: true }): Promise<Response>
  signUpEmail(args: { body: unknown; asResponse: true }): Promise<Response>
  signOut(args: { headers: Headers; asResponse: true }): Promise<Response>
}

const api = () => auth().instance.api as unknown as ServerApi

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
  .get('/sign-in', () => view(SignIn, { title: 'Sign in', error: errors().first('email') }))

  .get('/sign-up', () =>
    view(SignUp, { title: 'Create an account', error: errors().first('email') })
  )

  .get('/dashboard', ({ user }) => {
    // `user` is resolved by the auth plugin; `guest()` remembers where we were
    // going so signing in returns here rather than to the landing page.
    if (!user) return redirect('/sign-in').guest().toResponse()

    return view(Dashboard, { title: 'Dashboard', name: user.name ?? user.email })
  })

  .post(
    '/sign-in',
    async ({ body }) => {
      const answer = await api().signInEmail({
        body: { email: body.email, password: body.password },
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
    async ({ body }) => {
      const answer = await api().signUpEmail({
        body: { name: body.name, email: body.email, password: body.password },
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
