import { type Form, type FormOptions, useForm as base } from '@elvel/spa/vue'
import { csrf } from '@/api.ts'

/**
 * `useForm`, wired to this application's two answers.
 *
 * **The token.** The document is a shell, so there is none embedded in it. It comes
 * from `GET /api/session`, and is read per submission rather than captured: signing
 * in rotates the session id, and the token rotates with it.
 *
 * **Where a redirect goes.** A full document load, not `router.push`, and for a
 * reason a client-routed application makes easy to get wrong. The auth screens and
 * the application are **separate bundles** — signing in does not navigate within
 * this page, it leaves it for the other one. And signing in rotates the session on
 * purpose, so the token and the answer to "who is asking" are both stale the moment
 * it succeeds.
 *
 * A form that stays inside one bundle and reads its own data can pass `onRedirect`
 * and navigate client-side instead.
 */
export function useForm<T extends Record<string, unknown>>(
  initial: T,
  options: FormOptions = {}
): Form<T> {
  return base(initial, {
    token: csrf,
    onRedirect: (to) => window.location.assign(to),
    ...options
  })
}
