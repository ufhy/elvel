import { type Form, type FormOptions, useForm as base } from '@elvel/spa/vue'

/**
 * `useForm`, with this application's answer to "where does a redirect go".
 *
 * A full document load, not `router.push`, and the reason is measured rather than
 * cautious. The payload the client boots from describes **the document** — the
 * user, the CSRF token, the page's own data — and a client-side navigation does
 * not fetch a new one. Pushing to `/dashboard` after signing in therefore arrives
 * with the payload of the *sign-in* page: `user` is null, so the shell renders no
 * user menu and no way to sign out, and the CSRF token is the pre-sign-in one that
 * `regenerate()` has already invalidated.
 *
 * Signing in rotates the session id on purpose — session fixation — so a new
 * document is not a compromise here, it is the only correct answer. It costs one
 * request on something that happens once.
 *
 * A form whose page fetches its own data can pass `onRedirect` and navigate
 * client-side instead.
 */
export function useForm<T extends Record<string, unknown>>(
  initial: T,
  options: FormOptions = {}
): Form<T> {
  return base(initial, { onRedirect: (to) => window.location.assign(to), ...options })
}
