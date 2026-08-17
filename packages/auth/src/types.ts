import type { AuthUser } from './gate.ts'
import type { AuthSession } from './manager.ts'

/**
 * Where an application says what its own auth looks like.
 *
 * Two things the framework cannot know and must not guess: which endpoints
 * better-auth exposes — that depends on the plugins in `config/auth.ts` — and
 * what a user row contains, which depends on the same file plus whatever the
 * schema was generated with.
 *
 * An application fills it in once, by declaration merging, the way container
 * bindings are declared:
 *
 * ```ts
 * declare module '@elyvel/auth' {
 *   interface AuthTypes {
 *     api: Auth<typeof config>['api']
 *     user: { id: string; name: string; email: string; emailVerified: boolean }
 *   }
 * }
 * ```
 *
 * Deliberately **empty**. An interface with members cannot have them replaced by
 * merging — TypeScript refuses a second declaration with a different type — so
 * the defaults below are conditional rather than declared here.
 */
// biome-ignore lint/suspicious/noEmptyInterface: it is empty so an application can fill it; see above.
export interface AuthTypes {}

/** better-auth's API as this application typed it, or the little we can promise. */
export type AuthApi = AuthTypes extends { api: infer Api }
  ? Api
  : { getSession(args: { headers: Headers }): Promise<AuthSession | null> }

/** The user as this application typed it, or the open shape better-auth returns. */
export type CurrentUser = AuthTypes extends { user: infer User } ? User : AuthUser
