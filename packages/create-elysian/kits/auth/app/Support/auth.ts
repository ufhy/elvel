import { type AuthUser, authApi, userOf } from '@elysian/auth'
import type { Auth } from 'better-auth'
import type authConfig from '../../config/auth.ts'

/**
 * What this kit's pages know about better-auth that the framework cannot.
 *
 * The glue that is the same in every application — carrying the session cookie
 * onto a redirect, reading a message out of a refusal, shaping the session list
 * — lives in `@elysian/auth` as `withSession`, `messageFrom` and
 * `sessionSummaries`. What is left here is the part that depends on *this*
 * application's schema and on the endpoints its plugins provide.
 */

/**
 * better-auth's server API, typed from this application's own config.
 *
 * The types are real, not a claim: `betterAuth<Options>(options) => Auth<Options>`
 * infers the endpoints from the options object, plugins included, so reading
 * `typeof authConfig` back out of `config/auth.ts` recovers exactly what this
 * application has. Enable a plugin and its endpoints appear here; call one whose
 * plugin is not enabled and the compiler says so rather than the server.
 *
 * This was a hand-written list of endpoint signatures. It typechecked, and that
 * was the problem: a list somebody maintains says whatever they last believed,
 * and it accepted calls that would fail at runtime.
 */
export const api = () => authApi<Auth<typeof authConfig>['api']>()

/**
 * The signed-in user, with the three fields these pages render.
 *
 * `AuthUser` is `{ id } & Record<string, unknown>` on purpose — better-auth's
 * user table is whatever the application's plugins make it, and the framework
 * cannot promise a `name` that a schema may not have. So the narrowing happens
 * here, once, where this application's own schema is known, rather than with a
 * cast at every call site.
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
