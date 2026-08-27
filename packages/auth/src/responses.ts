import { auth } from './helpers.ts'
import type { AuthApi } from './types.ts'

/**
 * Carry better-auth's cookies onto the response you are actually sending.
 *
 * The glue every server-rendered application needs, and the reason it is here
 * rather than copied into each one: better-auth answers a *call* with its own
 * `Response` — JSON, with the session cookie on it — while what goes back to a
 * browser is a redirect. Without moving those headers across, signing in
 * appears to work and the browser is never given a session.
 *
 * ```ts
 * const answer = await api().signInEmail({ body, headers, asResponse: true })
 *
 * return withSession(answer, await redirect('/dashboard').seeOther().toResponse())
 * ```
 */
export function withSession(from: Response, to: Response): Response {
  const headers = new Headers(to.headers)

  for (const cookie of from.headers.getSetCookie()) headers.append('set-cookie', cookie)

  return new Response(to.body, { status: to.status, headers })
}

/**
 * The codes whose own wording beats anything a form could have written.
 *
 * Everything else gets the caller's sentence, and that is the point. better-auth's
 * `message` is written for whoever is integrating it, not for whoever is typing —
 * measured, a blank sign-up form answered
 * `[body.email] Invalid email address; [body.password] Too small: expected string
 * to have >=1 characters`, and a wrong second factor answered `Invalid two factor
 * cookie`, while the sentences the controllers had written for both were never
 * used.
 *
 * These three are here because each says something the form cannot know: whether
 * an address is taken, and whether a password missed a bound this application does
 * not set. Keyed on `code` rather than on the text, so a wording change upstream
 * does not silently drop one back to the fallback.
 */
const OWN_WORDS = new Set([
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG'
])

/** What better-auth refused with: its code, and the sentence to show for it. */
export type AuthProblem = {
  /** better-auth's machine code, or `''` when it gave none. */
  code: string

  /** What to show — the caller's sentence, unless the code is one of `OWN_WORDS`. */
  message: string
}

/**
 * Why better-auth refused, as both halves.
 *
 * The code is what a controller branches on — `PASSWORD_TOO_SHORT` belongs under
 * the password field, not under the email one — and the message is what it shows.
 * Both come from one read because a `Response` body can only be read once: a
 * controller calling `messageFrom` and then reaching for the code would find the
 * stream already drained.
 */
export async function problemFrom(response: Response, fallback: string): Promise<AuthProblem> {
  try {
    const body = (await response.json()) as { message?: unknown; code?: unknown }
    const code = typeof body.code === 'string' ? body.code : ''
    const said = typeof body.message === 'string' ? body.message.trim() : ''

    return { code, message: OWN_WORDS.has(code) && said !== '' ? said : fallback }
  } catch {
    return { code: '', message: fallback }
  }
}

/**
 * What to show when better-auth refused.
 *
 * The caller's sentence, unless better-auth's code is one whose own wording says
 * more than a form could — see `OWN_WORDS`. The detail of *why* a sign-in failed
 * tells an attacker more than it tells the person typing, which is the other reason
 * the caller decides.
 */
export async function messageFrom(response: Response, fallback: string): Promise<string> {
  return (await problemFrom(response, fallback)).message
}

/**
 * better-auth's server API, typed as this application declared it.
 *
 * The framework cannot type this on its own: which endpoints exist depends on
 * the plugins in `config/auth.ts`, so a type listing them would be wrong for
 * every application but one. What an application *can* do is say so once, by
 * filling in `AuthTypes` — and better-auth already computes the answer, since
 * `betterAuth<Options>(options)` returns `Auth<Options>`:
 *
 * ```ts
 * declare module '@elvel/auth' {
 *   interface AuthTypes {
 *     api: Auth<typeof config>['api']
 *   }
 * }
 * ```
 *
 * Without that declaration this is `getSession` and nothing else, which is all
 * the framework itself uses.
 */
export function api(): AuthApi {
  return auth().instance.api as AuthApi
}

/** One row of `listSessions`, as a page renders it. */
export type SessionSummary = {
  /** The session's token — what `revokeSession` takes. */
  id: string
  /** Is this the browser reading the page? */
  current: boolean
  createdAt?: string | undefined
  expiresAt?: string | undefined
  userAgent?: string | undefined
  ipAddress?: string | undefined
}

/**
 * better-auth's session list, shaped for a page — and with *this* one marked.
 *
 * Which row is the current browser is decided by comparing the session token in
 * the request's own cookie, because the list itself does not say. Marking the
 * wrong row current would offer somebody a "sign this out" button that ends the
 * session they are reading it in, which is the one mistake this must not make.
 */
export function sessionSummaries(listed: unknown, headers: Headers): SessionSummary[] {
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
