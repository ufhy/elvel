import { Elysia } from 'elysia'

/**
 * A conditional GET: the cheapest response is the one with no body.
 *
 * A browser or a mobile client that already has a copy sends back what it has,
 * and a server that answers `304` sends headers and nothing else. Every response
 * was being sent in full whether or not anything had changed, which for an API
 * behind a CDN is the largest easy saving there is.
 *
 * Only safe methods and only successful responses: a `304` in answer to a POST
 * means something quite different, and a conditional header on an error response
 * would have the client keep showing a page that no longer exists.
 */
export function conditionalPlugin(options: { autoEtag?: boolean } = {}) {
  return new Elysia({ name: 'elvel/conditional' }).onAfterHandle(
    { as: 'global' },
    async ({ request, set, response }) => {
      if (!isSafe(request.method)) return

      const headers = set.headers as Record<string, string | undefined>
      const built = response instanceof Response ? response : undefined
      const status = Number(built?.status ?? set.status ?? 200)

      if (status !== 200) return

      const etag = built?.headers.get('etag') ?? headers.etag
      const modified = built?.headers.get('last-modified') ?? headers['last-modified']

      // Nothing said what this response is, so nothing can be compared. Hashing
      // every body to find out would cost more than it saves on the pages that
      // are large enough to matter.
      if (etag === undefined && modified === undefined && options.autoEtag !== true) return

      const tag = etag ?? (built === undefined ? undefined : await etagFor(built))

      if (tag !== undefined && built === undefined) headers.etag = tag

      if (!isStale(request, tag, modified)) {
        return notModified(tag, modified, built ?? undefined)
      }

      if (tag !== undefined && built !== undefined && built.headers.get('etag') === null) {
        built.headers.set('etag', tag)
      }

      return built
    }
  )
}

/** `GET` and `HEAD`. A `304` to anything else means something quite different. */
function isSafe(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

/**
 * Has it changed since the client last saw it?
 *
 * `If-None-Match` wins outright when both are sent, which is what the RFC says
 * and what matters in practice: an entity tag is exact and a timestamp has a
 * one-second resolution, so a file written twice in a second compares equal.
 */
export function isStale(
  request: Request,
  etag: string | undefined,
  lastModified: string | undefined
): boolean {
  const noneMatch = request.headers.get('if-none-match')

  if (noneMatch !== null && etag !== undefined) return !matchesEtag(noneMatch, etag)

  const since = request.headers.get('if-modified-since')

  if (since !== null && lastModified !== undefined) {
    const had = Date.parse(since)
    const has = Date.parse(lastModified)

    if (Number.isFinite(had) && Number.isFinite(has)) return has > had
  }

  return true
}

/**
 * A weak tag matches a strong one of the same value.
 *
 * `W/"abc"` and `"abc"` are the same representation as far as a conditional GET
 * is concerned — the weak marker only rules out byte-range requests, which this
 * is not.
 */
function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') return true

  const bare = (value: string) => value.trim().replace(/^W\//, '')

  return header.split(',').some((candidate) => bare(candidate) === bare(etag))
}

/** The body is dropped; the validators and the caching headers are not. */
function notModified(
  etag: string | undefined,
  lastModified: string | undefined,
  from: Response | undefined
): Response {
  const headers = new Headers()

  for (const name of ['cache-control', 'content-location', 'date', 'expires', 'vary']) {
    const value = from?.headers.get(name)

    if (value !== null && value !== undefined) headers.set(name, value)
  }

  if (etag !== undefined) headers.set('etag', etag)
  if (lastModified !== undefined) headers.set('last-modified', lastModified)

  return new Response(null, { status: 304, headers })
}

/**
 * A tag for a response's bytes.
 *
 * The response is cloned: reading the body consumes it, and a caller that got a
 * `200` still needs one to send.
 */
export async function etagFor(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.clone().arrayBuffer())

  return `"${Bun.hash(bytes).toString(16)}"`
}

/** A tag for anything else — a string, an object, a version number. */
export function etag(value: string | object | number, weak = false): string {
  const source = typeof value === 'object' ? JSON.stringify(value) : String(value)

  return `${weak ? 'W/' : ''}"${Bun.hash(source).toString(16)}"`
}
