import { app } from '@elvel/core'
import { routes } from './route-helpers.ts'

/** The scheme every absolute URL is forced onto, when one is. */
let forced: string | undefined

/**
 * URLs to things that are not named routes.
 *
 * `route()` covers what the application answers; this covers the rest — a file
 * in `public/`, a path built somewhere that has no name, a link that must be
 * https because the mail client will not follow anything else.
 */
export const Url = {
  /**
   * Build every absolute URL on this scheme.
   *
   * Behind a TLS-terminating proxy the application sees plain http, so links in
   * a mail come out http and a browser refuses to post a form back to them.
   * Pass nothing to stop forcing.
   */
  forceScheme(scheme?: string): void {
    // Trimmed by hand rather than with `/:?\/*$/`, which measures linear here
    // but is the shape a static analyser calls polynomial. Nothing is lost.
    forced = scheme === undefined ? undefined : trimSchemeTail(scheme)
  },

  /** The scheme being forced, if any. */
  forcedScheme(): string | undefined {
    return forced
  },

  /** Parameters every `route()` may take without being handed them. */
  defaults(values: Record<string, unknown>): void {
    routes().defaults(values)
  },

  /** What those parameters currently are. */
  defaulted(): Record<string, unknown> {
    return routes().defaulted()
  }
}

/**
 * An absolute URL to a path.
 *
 * ```ts
 * url('/articles')                    // https://example.com/articles
 * url('/articles', { page: 2 })       // https://example.com/articles?page=2
 * ```
 *
 * An absolute URL passed in is returned untouched, so a value that may already
 * be one does not need checking at the call site.
 */
export function url(path = '', query: Record<string, unknown> = {}): string {
  return build(origin(), path, query)
}

/** The same, over https, whatever the origin says. */
export function secureUrl(path = '', query: Record<string, unknown> = {}): string {
  return build(secure(origin()), path, query)
}

/**
 * A URL to a file served from `public/`.
 *
 * Reads `app.assetUrl` first, so moving static files to a CDN is one environment
 * variable rather than an edit to every template that names an image.
 */
export function asset(path = ''): string {
  const host = app().config.get<string>('app.assetUrl', '') || origin()

  return build(host.replace(/\/$/, ''), path, {})
}

/** The same, over https. */
export function secureAsset(path = ''): string {
  return secure(asset(path))
}

/** Where absolute URLs point — the registry's origin, under the forced scheme. */
function origin(): string {
  const at = routes().origin || app().config.get<string>('app.url', 'http://localhost')

  return scheme(at.replace(/\/$/, ''), forced)
}

function build(host: string, path: string, query: Record<string, unknown>): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue

    search.set(key, String(value))
  }

  const suffix = search.toString() === '' ? '' : `?${search}`

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return `${path}${suffix}`

  return `${host}/${path.replace(/^\/+/, '')}`.replace(/\/$/, '') + suffix
}

function secure(at: string): string {
  return scheme(at, 'https')
}

function scheme(at: string, to: string | undefined): string {
  if (to === undefined) return at

  return at.replace(/^[a-z][a-z0-9+.-]*:/i, `${to}:`)
}

/** `https://` and `https:` both become `https`. */
function trimSchemeTail(scheme: string): string {
  let end = scheme.length

  while (end > 0 && scheme[end - 1] === '/') end -= 1
  if (end > 0 && scheme[end - 1] === ':') end -= 1

  return scheme.slice(0, end)
}
