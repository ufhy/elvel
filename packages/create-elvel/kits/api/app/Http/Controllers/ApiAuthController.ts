import { api, userOf } from '@elvel/auth'

/**
 * What better-auth says when it refuses, as JSON rather than as a page.
 *
 * Its body is already JSON; this is only about not passing an HTML error
 * through, and about the message being somewhere a client will look.
 */
async function refusal(answer: Response, fallback: string): Promise<Response> {
  const body = (await answer
    .clone()
    .json()
    .catch(() => ({}))) as { message?: string }

  return Response.json(
    { message: body.message ?? fallback },
    { status: answer.status === 200 ? 400 : answer.status }
  )
}

type RegisterBody = { name: string; email: string; password: string }
type LoginBody = { email: string; password: string }

/**
 * Auth for an API client — no sessions, no cookies, no pages.
 *
 * The token is better-auth's own session token, handed out on sign-in through
 * the `set-auth-token` header that the `bearer` plugin adds. A client sends it
 * back as `Authorization: Bearer …` and is recognised on every route, because
 * `auth()` gives better-auth the request's headers and a token is read exactly
 * where a cookie would be. There is no second identity table and no second
 * notion of a session — a personal-access-token store, Sanctum's shape, is a
 * different feature and one this kit deliberately does not invent.
 *
 * Everything lives under `/api`, which `config/session.ts` already exempts from
 * CSRF — that check exists for a browser that sends cookies without being asked,
 * and a bearer token is never sent that way.
 *
 * The paths, the throttling and the body schemas are in `routes/api.ts`. A
 * controller says what happens; the routes file says when.
 */
export default class ApiAuthController {
  async register({ body, request }: { body: RegisterBody; request: Request }) {
    const answer = await api().signUpEmail({
      body: { name: body.name, email: body.email, password: body.password },
      headers: request.headers,
      asResponse: true
    })

    if (!answer.ok) return await refusal(answer, 'That account could not be created.')

    return Response.json(
      {
        token: answer.headers.get('set-auth-token'),
        user: ((await answer.json()) as { user?: unknown }).user ?? null
      },
      { status: 201 }
    )
  }

  async login({ body, request }: { body: LoginBody; request: Request }) {
    const answer = await api().signInEmail({
      body: { email: body.email, password: body.password },
      /**
       * The headers travel, as they do in the web kit.
       *
       * better-auth records the user agent and address from whatever request it
       * is handed; called without them every session row reads "Unknown", which
       * is a list of dates nobody can act on.
       */
      headers: request.headers,
      asResponse: true
    })

    if (!answer.ok) return await refusal(answer, 'Those details did not match.')

    return Response.json({
      token: answer.headers.get('set-auth-token'),
      user: ((await answer.json()) as { user?: unknown }).user ?? null
    })
  }

  /** Who the token belongs to — the endpoint every client calls first. */
  user(context: object) {
    return Response.json({ user: userOf(context as never) })
  }

  async logout({ request }: { request: Request }) {
    // Revoked at the source: the token is the session, so signing out ends it
    // for good rather than asking the client to forget it.
    await api().signOut({ headers: request.headers, asResponse: true })

    return new Response(null, { status: 204 })
  }
}
