import { type AuthUser, auth, userOf } from '@elysian/auth'
import type { SessionRow } from '../../resources/views/pages/settings/security.tsx'

/**
 * What the auth pages share.
 *
 * These four were defined once inside a 619-line controller that held every
 * route this kit ships. Splitting the controller by area — sign-in and its
 * neighbours, settings, verification, the confirmation window — left them
 * needed in several places at once, and copying them into each would be four
 * copies of the narrowing that keeps `account()` honest.
 */

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

export const api = () => auth().instance.api as unknown as ServerApi

/**
 * The signed-in user, with the three fields these pages render.
 *
 * `AuthUser` is `{ id } & Record<string, unknown>` on purpose — better-auth's
 * user table is whatever the application's plugins make it, and the framework
 * cannot promise a `name` that a schema may not have. So the narrowing happens
 * here, once, where this kit's own schema is known, rather than with a cast at
 * every call site.
 */
export function account(context: unknown): { name: string; email: string; emailVerified: boolean } {
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

/** Move better-auth's `Set-Cookie` headers onto the response we are sending. */
export function withSession(from: Response, to: Response): Response {
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
export async function messageFrom(response: Response, fallback: string): Promise<string> {
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
export function sessionRows(listed: unknown, headers: Headers): SessionRow[] {
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
