import { app } from '@elvel/core'
import { Attempting, announce, Failed, Login, Validated } from './events.ts'
import type { AuthManager } from './manager.ts'

type Context = { request: Request }

export type BasicOptions = {
  /** What the browser shows in its prompt. */
  realm?: string
  /** The user column the username is matched against. */
  field?: string
  /** Leave no session behind — for a `/metrics` endpoint or a webhook. */
  once?: boolean
}

/**
 * `Authorization: Basic`, which is the first thing every internal tool reaches
 * for.
 *
 * There was no way to put a username and password in front of a route at all —
 * not for a staging environment, not for `/metrics`, not for an admin page
 * behind a VPN. The route needed a full sign-in flow or nothing.
 *
 * Stateless by default is **not** the choice here: `once` exists for that, and
 * the ordinary case signs in properly so the rest of the framework — the gate,
 * `user()`, the audit events — sees the same user it would have seen from a
 * cookie.
 */
export function basicAuth(options: BasicOptions = {}) {
  const realm = options.realm ?? 'Restricted'

  return async (context: Context): Promise<Response | undefined> => {
    const credential = parseBasic(context.request.headers.get('authorization'))

    if (credential === undefined) return challenge(realm)

    const [identifier, password] = credential

    announce(new Attempting(identifier))

    const manager = app('auth') as AuthManager
    const signedIn = await attempt(manager, identifier, password, context.request, options.once)

    if (!signedIn) {
      announce(new Failed(identifier, 'web', 'invalid credentials'))

      return challenge(realm)
    }

    return undefined
  }
}

/** The same, leaving nothing behind — a webhook or a scrape endpoint. */
export function basicAuthOnce(options: Omit<BasicOptions, 'once'> = {}) {
  return basicAuth({ ...options, once: true })
}

/**
 * `WWW-Authenticate`, which is what makes a browser prompt at all.
 *
 * Without the header a browser shows the 401 body and never asks for a
 * credential, so the route is simply broken rather than protected.
 */
function challenge(realm: string): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      // The realm is quoted and its quotes are stripped: a realm that closes
      // the string early would inject a parameter of its own.
      'www-authenticate': `Basic realm="${realm.replaceAll(/["\\\r\n]/g, '')}", charset="UTF-8"`
    }
  })
}

/**
 * The username and password out of the header.
 *
 * A password may contain a colon and a username may not, so the split is on the
 * **first** one — splitting on every colon truncates a perfectly good password
 * and produces a failure nobody can explain.
 */
export function parseBasic(header: string | null): [string, string] | undefined {
  if (header === null) return undefined

  const [scheme, encoded] = header.split(' ')

  if (scheme?.toLowerCase() !== 'basic' || encoded === undefined) return undefined

  let decoded: string

  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    return undefined
  }

  const separator = decoded.indexOf(':')

  if (separator === -1) return undefined

  return [decoded.slice(0, separator), decoded.slice(separator + 1)]
}

/**
 * Check the credential against better-auth.
 *
 * `asResponse` so the session cookie comes back on a real response, and the
 * timing of a wrong password is better-auth's problem rather than a comparison
 * written here — it hashes before it compares, which is the constant-time part
 * that matters. A username that does not exist and a password that is wrong
 * both land in the same branch.
 */
async function attempt(
  manager: AuthManager,
  identifier: string,
  password: string,
  request: Request,
  once = false
): Promise<boolean> {
  /**
   * Cast through `unknown`: the declared surface is what the framework itself
   * uses, and an application's own `AuthTypes` decides what else better-auth
   * exposes. A sign-in endpoint exists in every configuration that has a
   * password at all, and one that does not answers the same way a wrong
   * password does.
   */
  const api = manager.instance.api as unknown as {
    signInEmail(input: {
      body: { email: string; password: string }
      headers?: Headers
      asResponse?: boolean
    }): Promise<Response>
    signOut(input: { headers: Headers }): Promise<unknown>
  }

  let answer: Response

  try {
    answer = await api.signInEmail({
      body: { email: identifier, password },
      headers: request.headers,
      asResponse: true
    })
  } catch {
    return false
  }

  if (!answer.ok) return false

  announce(new Validated({ id: identifier } as never))
  announce(new Login(identifier))

  if (once) {
    /**
     * A stateless check leaves nothing behind.
     *
     * better-auth writes a session row to answer at all, so this signs straight
     * back out rather than pretending the row was never written — an endpoint
     * polled every fifteen seconds would otherwise accumulate one session per
     * poll.
     */
    const cookies = answer.headers.getSetCookie().join('; ')

    await api.signOut({ headers: new Headers({ cookie: cookies }) }).catch(() => undefined)
  }

  return true
}
