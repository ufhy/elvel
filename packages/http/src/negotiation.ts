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
 * browser.
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
   * **A redirect** treats it as a browser.
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

/**
 * One `Accept` entry: a type, its quality, and how specific it is.
 *
 * Specificity is kept because the header ranks by quality first and by
 * specificity second — `text/html` beats `text/*` beats `*&#47;*` at the same
 * `q`, which is what makes a client's `Accept: *&#47;*;q=0.8, text/csv` mean
 * "CSV, or anything".
 */
type Acceptable = { type: string; quality: number; specificity: number }

/** Every media type the caller will take, best first. */
export function getAcceptableContentTypes(source?: Negotiable): string[] {
  return parseAccept(acceptHeader(source)).map((entry) => entry.type)
}

/**
 * Will the caller take any of these?
 *
 * `accepts(['text/html', 'application/json'])` answers the first one the header
 * allows, or `undefined`. A caller that sent no `Accept` will take anything, so
 * the first type wins — that is what an absent header means, and answering
 * nothing would make every scripted request fail.
 */
export function accepts(types: string[], source?: Negotiable): string | undefined {
  const header = acceptHeader(source)

  if (header.trim() === '') return types[0]

  const ranked = parseAccept(header)

  for (const entry of ranked) {
    const match = types.find((type) => matchesType(entry.type, type))

    if (match !== undefined) return match
  }

  return undefined
}

/**
 * Of the types we can produce, the one the caller would rather have.
 *
 * The difference from `accepts`: this ranks by what the *header* prefers rather
 * than by the order we listed. An endpoint that can serve HTML, JSON and CSV
 * lists all three and lets the client choose.
 */
export function prefers(types: string[], source?: Negotiable): string | undefined {
  const header = acceptHeader(source)

  if (header.trim() === '') return types[0]

  let best: { type: string; quality: number; specificity: number } | undefined

  for (const entry of parseAccept(header)) {
    for (const type of types) {
      if (!matchesType(entry.type, type)) continue

      if (
        best === undefined ||
        entry.quality > best.quality ||
        (entry.quality === best.quality && entry.specificity > best.specificity)
      ) {
        best = { type, quality: entry.quality, specificity: entry.specificity }
      }
    }
  }

  return best?.type
}

export function acceptsHtml(source?: Negotiable): boolean {
  return accepts(['text/html'], source) !== undefined
}

export function acceptsJson(source?: Negotiable): boolean {
  return accepts(['application/json'], source) !== undefined
}

/** Whether the caller said `*&#47;*` — it will take whatever we send. */
export function acceptsAnyContentType(source?: Negotiable): boolean {
  const header = acceptHeader(source)

  if (header.trim() === '') return true

  return parseAccept(header).some((entry) => entry.type === '*/*')
}

function acceptHeader(source?: Negotiable): string {
  const from: Negotiable | undefined = source ?? currentScope()

  return from?.headers?.accept ?? from?.request?.headers.get('accept') ?? ''
}

/** Best first: quality, then specificity, then the order they were written. */
function parseAccept(header: string): Acceptable[] {
  return header
    .split(',')
    .map((entry, index) => {
      const [type, ...parameters] = entry.trim().split(';')
      const quality = parameters
        .map((part) => part.trim())
        .find((part) => part.startsWith('q='))
        ?.slice(2)

      const weight = quality === undefined ? 1 : Number(quality)
      const name = (type ?? '').trim().toLowerCase()

      return {
        type: name,
        quality: Number.isFinite(weight) ? weight : 0,
        specificity: name === '*/*' ? 0 : name.endsWith('/*') ? 1 : 2,
        index
      }
    })
    .filter((entry) => entry.type !== '' && entry.quality > 0)
    .sort(
      (left, right) =>
        right.quality - left.quality ||
        right.specificity - left.specificity ||
        left.index - right.index
    )
}

/** `text/*` matches `text/csv`; `*&#47;*` matches everything. */
function matchesType(pattern: string, type: string): boolean {
  if (pattern === '*/*') return true

  const wanted = type.toLowerCase()

  if (pattern === wanted) return true

  return pattern.endsWith('/*') && wanted.startsWith(`${pattern.slice(0, -1)}`)
}
