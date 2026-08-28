import {
  call,
  type CallOptions,
  Invalid,
  NeedsPasswordConfirmation,
  Unauthenticated
} from '@elvel/client'

export { Invalid, NeedsPasswordConfirmation, Unauthenticated }

/**
 * What this application knows about talking to its server.
 *
 * The document is a shell — `spa.embed` is off — so nothing arrives with the page.
 * That is the trade a single-page application makes: the same bytes for everybody
 * and a cache that may keep them, in exchange for asking two questions on boot
 * instead of nought. Who is asking, and what is this screen looking at.
 *
 * `@elvel/spa/client` decides what a request looks like: the session cookie rather
 * than a token in storage, `accept: application/json` so an expired session arrives
 * as a 401 instead of as HTML, the CSRF token on writes, and 401 and 422 as two
 * types a router and a form can act on.
 */
export type User = {
  id: string
  name: string
  email: string
  emailVerified: boolean
}

type Session = { app: string; user: User | null; csrf: string }

/**
 * The answer to "who is asking", held for the life of the page.
 *
 * Module state rather than a store, because there is one of these per document and
 * nothing in the application may disagree about it. `boot()` fills it before the app
 * mounts, so no component ever sees it empty.
 */
let current: Session = { app: 'Elvel', user: null, csrf: '' }

/** Ask the server who this is. Called by the entry, and again after signing in. */
export async function boot(): Promise<Session> {
  current = await call<Session>('/session')

  return current
}

export const currentUser = (): User | null => current.user

export const appName = (): string => current.app

/**
 * The token every write sends back.
 *
 * From `/api/session` rather than from the document, which is the one thing a shell
 * cannot carry: a token is per session, and a document carrying one would be per
 * session too — which is exactly the cacheability a shell exists for.
 */
export const csrf = (): string => current.csrf

/**
 * A request with this session's token attached.
 *
 * Every write goes through here rather than through the client directly. It reads
 * the token from the document by default, and there is no document to read — so
 * forgetting the override would not fail loudly, it would fail as a 419 from
 * somewhere else entirely.
 *
 * Everything else is already decided by `@elvel/spa/client`: the cookie rather
 * than a header, `accept: application/json` so a dead session is a 401 and not a
 * page, `content-type` on writes but never on a form, and 401, 422 and 423 as
 * types. What is left for an application is the token and the paths.
 *
 * ```ts
 * const listed = await ask<Page<Invoice>>('/invoices', { query: { status, page } })
 *
 * await ask('/avatar', { method: 'POST', body: form })   // FormData, sent as it is
 * ```
 */
export const ask = <T>(path: string, options: CallOptions = {}) =>
  call<T>(path, { token: current.csrf, ...options })

export const api = {
  profile: () => ask<{ name: string; email: string; emailVerified: boolean }>('/settings/profile'),

  sessions: () =>
    ask<{
      sessions: Array<{
        id: string
        current: boolean
        createdAt?: string
        expiresAt?: string
        userAgent?: string
        ipAddress?: string
      }>
    }>('/settings/sessions'),

  passkeys: () =>
    ask<{
      passkeys: Array<{ id: string; name: string; createdAt?: string; deviceType?: string }>
    }>('/settings/passkeys'),

  twoFactor: () =>
    ask<{
      enabled: boolean
      pending?: { uri: string; secret: string; codes: string[] }
    }>('/settings/two-factor')
}
