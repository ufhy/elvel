/**
 * What this application knows about talking to its server.
 *
 * `@elvel/spa/client` decides the four things every request needs — the session
 * cookie rather than a token in storage, `accept: application/json` so an expired
 * session arrives as a 401 instead of as HTML, the CSRF token on writes, and 401
 * and 422 as two types a router and a form can act on.
 *
 * What belongs here is your application's shape: the endpoints it calls and the
 * types they answer with. Note what is *not* here — signing out. That is an auth
 * flow, and in this kit the auth flows are pages: the shell posts a form to
 * `/sign-out` and the server redirects, which needs no client code at all.
 */
export { call, Invalid, page, Unauthenticated } from '@elvel/spa/client'

import { call, page } from '@elvel/spa/client'

export type User = { id: string; name: string; email: string }

/** Who the document was rendered for, without asking the server again. */
export const currentUser = (): User | null => (page as { user?: User | null }).user ?? null

/** The token every write sends back, from the document the server rendered. */
export const csrf = (): string => (page as { csrf?: string }).csrf ?? ''

export const api = {
  /** The endpoint every client calls when it needs to be sure. */
  me: () => call<{ user: User }>('/user')
}
