import { currentScope } from './scope.ts'

/** Where the headers for a decision come from — a handler context, or the scope. */
export type Negotiable = {
  headers?: Record<string, string | undefined>
  request?: Request
}

/**
 * Does this caller want JSON, or is it a browser posting a form?
 *
 * Getting this wrong is not cosmetic in either direction — an API would receive a
 * 302 it cannot follow, and a form would receive a 422 it cannot show — so the
 * decision reads four signals rather than one:
 *
 * 1. `X-Requested-With: XMLHttpRequest` — how a `fetch()` from a page says it is
 *    not navigating.
 * 2. `Accept` naming JSON.
 * 3. A **JSON request body**. A browser form posts `x-www-form-urlencoded` or
 *    `multipart/form-data` and can post nothing else; anything sending JSON is a
 *    client. This is the signal that was missing when the playground's API routes
 *    started being redirected instead of answered.
 * 4. No `Accept` at all, which no browser omits — but only where the caller asked
 *    for that reading, via `whenSilent`.
 *
 * Otherwise: a caller that accepts HTML — or anything, `*&#47;*` — is treated as a
 * browser, which is Laravel's reading too.
 *
 * Lives here rather than on `FormRequest`, where it started, because two callers
 * need the same answer: validation deciding between a 422 and a redirect, and
 * `Redirect` deciding whether a redirect is even a thing this caller can follow.
 * Two copies of a four-signal rule is two chances for them to disagree.
 */
export function expectsJson(
  source?: Negotiable,
  /**
   * What silence means, and the two callers disagree — on purpose.
   *
   * **Validation** treats an absent `Accept` as a client: no browser omits the
   * header, so whatever did is a script, and answering it a 422 is kinder than a
   * redirect it cannot follow.
   *
   * **A redirect** treats it as a browser, which is Laravel's own reading
   * (`expectsJson()` there needs `X-Requested-With` before a wildcard counts).
   * The difference is what is at stake when the guess is wrong: mistaking silence
   * for a client turns every `Request` built without headers — a test, an internal
   * dispatch, a health probe — into one that receives JSON where a 302 was the
   * whole point. Measured, not reasoned: it broke 29 tests.
   */
  { whenSilent = true }: { whenSilent?: boolean } = {}
): boolean {
  /**
   * A scope carries only the request; a handler context carries a parsed header
   * record as well, and that one is preferred — Elysia has already lowercased it.
   */
  const from: Negotiable | undefined = source ?? currentScope()
  const headers = from?.headers ?? {}
  const header = (name: string) => headers[name] ?? from?.request?.headers.get(name) ?? ''

  if (header('x-requested-with').toLowerCase() === 'xmlhttprequest') return true

  const accept = header('accept')
  if (accept.includes('application/json')) return true

  if (header('content-type').includes('application/json')) return true

  if (accept === '') return whenSilent

  return !accept.includes('text/html') && !accept.includes('*/*')
}
