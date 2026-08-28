import { type Form, type FormOptions, useForm as base } from '@elvel/client/vue'
import { csrf } from '@/api.ts'
import { confirmed } from '@/composables/usePasswordConfirm.ts'

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
  const form = base(initial, {
    token: csrf,
    onRedirect: (to) => window.location.assign(to),
    ...options
  })

  /**
   * **The password wall.** Every write goes through `confirmed`, which asks in a
   * dialog and then sends the same submission again.
   *
   * Wrapped in place rather than by returning a new object: `form` is reactive, and
   * a spread of it is a snapshot that stops updating — the button would never
   * re-enable and no error would ever appear.
   *
   * Without this a `423` threw with nothing catching it, so the form simply did
   * nothing at all: measured on "generate new recovery codes" after the
   * confirmation had timed out. `useResource` had its own handling for reads and
   * writes had none.
   */
  for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
    const send = form[verb]

    /**
     * `/api` in front, decided here rather than in each view.
     *
     * Every address this backend answers for a client lives under `/api` — the
     * reads already did, and `routes/auth.ts` and `routes/settings.ts` put the
     * writes there too. What that buys is one address per thing: `/sign-in` is a
     * screen the Vue router owns and nothing else, and the document route no longer
     * shares a path with a form post.
     *
     * The views still write `form.post('/sign-in')`, which is the address a reader
     * recognises. `useForm` sends with `prefix: ''`, so the prefix has to be added
     * to the path itself.
     */
    form[verb] = (path: string) => confirmed(() => send(`/api${path}`))
  }

  return form
}
