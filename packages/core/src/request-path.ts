/**
 * The path and query of a request, without parsing a URL.
 *
 * `new URL(request.url).pathname` is the obvious way to write this, and eight
 * plugins on the request path each wrote it independently — two of them
 * (`http/src/provider.ts`) parsing the same URL **twice** in one expression. A
 * CPU profile of a scaffolded `api` application under load put `URL` at 4.2% of
 * all samples, on a route that returns `{ ok: true }` and reads nothing.
 *
 * A URL object is the wrong tool for the question every one of those callers was
 * asking. They want the path, as a string, to compare against a prefix — and
 * `request.url` is already an absolute, **already normalised** URL, because the
 * `Request` constructor parses and re-serialises it. Verified against `URL` for
 * traversal (`/build/../.env` → `/.env`), encoded traversal (`/%2e%2e/secret` →
 * `/secret`), dot segments, double slashes, empty paths, fragments, ports and
 * percent-encoded spaces: identical every time, which is what makes the string
 * scan safe rather than merely faster.
 *
 * Not for callers that **change** the URL — `signed-url.ts` strips a parameter,
 * `redirect.ts` builds a new location. Those want a real URL object and still
 * construct one.
 */

/** Where the path starts in an absolute URL: the first `/` after `scheme://`. */
function pathStart(url: string): number {
  const scheme = url.indexOf('://')

  return scheme === -1 ? -1 : url.indexOf('/', scheme + 3)
}

/** Where the path ends: at `?`, at `#`, or at the end of the string. */
function pathEnd(url: string, from: number): number {
  for (let index = from; index < url.length; index++) {
    const code = url.charCodeAt(index)

    // 63 is `?` and 35 is `#`. Compared as codes rather than with `indexOf`
    // twice, because either may be absent and the earlier one wins.
    if (code === 63 || code === 35) return index
  }

  return url.length
}

/**
 * The request's path, as `URL.pathname` would give it.
 *
 * A URL with no path at all — `http://host` — has a path of `/`, which is what
 * `URL` answers too.
 */
export function requestPath(request: Request): string {
  const url = request.url
  const start = pathStart(url)

  if (start === -1) return '/'

  return url.slice(start, pathEnd(url, start))
}

/**
 * The request's query, leading `?` included, or an empty string.
 *
 * Matches `URL.search`, which is also empty rather than `?` when there is no
 * query. A fragment ends it: `#` is never sent to a server, but a `Request`
 * built in a test can carry one.
 */
export function requestSearch(request: Request): string {
  const url = request.url
  const query = url.indexOf('?')

  if (query === -1) return ''

  const fragment = url.indexOf('#', query)

  return fragment === -1 ? url.slice(query) : url.slice(query, fragment)
}

/** Path and query together — what a log line or a redirect target wants. */
export function requestTarget(request: Request): string {
  return requestPath(request) + requestSearch(request)
}
