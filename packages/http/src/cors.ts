/**
 * CORS, transcribed from `fruitcake/php-cors` — the service Laravel delegates to.
 *
 * Two rules in here are the ones people get wrong, and both are enforced rather
 * than documented:
 *
 * - **`*` and credentials cannot go together.** A browser refuses
 *   `Access-Control-Allow-Origin: *` on a credentialed request, so allowing "any
 *   origin" with `supportsCredentials` means echoing the caller's own origin —
 *   and that is only safe because the origin was checked first.
 * - **A dynamic origin needs `Vary: Origin`.** Without it a shared cache can hand
 *   one site's allowed response to another site, which is a same-origin policy
 *   hole created by a proxy rather than by the browser.
 */
export type CorsConfig = {
  /** Paths this applies to. `api/*` style; `*` matches within one segment set. */
  paths: string[]
  allowedMethods: string[]
  allowedOrigins: string[]
  /** Regular expressions, for `https://*.example.com` style matching. */
  allowedOriginsPatterns: string[]
  allowedHeaders: string[]
  exposedHeaders: string[]
  /** Seconds a browser may cache the preflight. */
  maxAge: number
  supportsCredentials: boolean
}

export const CORS_DEFAULTS: CorsConfig = {
  paths: [],
  allowedMethods: ['*'],
  allowedOrigins: ['*'],
  allowedOriginsPatterns: [],
  allowedHeaders: ['*'],
  exposedHeaders: [],
  maxAge: 0,
  supportsCredentials: false
}

export function corsConfig(partial: Partial<CorsConfig> = {}): CorsConfig {
  return { ...CORS_DEFAULTS, ...partial }
}

/** A request carrying an `Origin`, which is what makes it cross-origin at all. */
export function isCorsRequest(request: Request): boolean {
  return request.headers.has('origin')
}

/** `OPTIONS` **plus** the method header: an ordinary OPTIONS is not a preflight. */
export function isPreflight(request: Request): boolean {
  return request.method === 'OPTIONS' && request.headers.has('access-control-request-method')
}

/** Does this path opt into CORS at all? `api/*` matches `api/anything/here`. */
export function pathMatches(config: CorsConfig, request: Request): boolean {
  const path = new URL(request.url).pathname.replace(/^\/+/, '')

  return config.paths.some((pattern) => {
    const trimmed = pattern.replace(/^\/+/, '')

    if (trimmed === '*') return true
    if (!trimmed.includes('*')) return path === trimmed

    const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

    return new RegExp(`^${escaped}$`).test(path)
  })
}

export function isOriginAllowed(config: CorsConfig, origin: string): boolean {
  if (config.allowedOrigins.includes('*')) return true
  if (config.allowedOrigins.includes(origin)) return true

  return config.allowedOriginsPatterns.some((pattern) => new RegExp(pattern).test(origin))
}

/**
 * The headers for an actual (non-preflight) response.
 *
 * Returns nothing when the origin is not allowed: a refused CORS request is a
 * normal response *without* the headers — the browser is what turns that into an
 * error, and answering 403 here would break same-origin callers too.
 */
export function actualHeaders(config: CorsConfig, request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  if (origin === null) return {}

  const headers = originHeaders(config, origin)

  // Everything else hangs off the origin being allowed. Testing for a non-empty
  // object instead would pass on the refusal branch, which returns `Vary` alone —
  // and a refused caller would be told the credentials and exposed headers it
  // cannot use. fruitcake tests for this exact header, and so does this.
  if (!('Access-Control-Allow-Origin' in headers)) return headers

  if (config.supportsCredentials) headers['Access-Control-Allow-Credentials'] = 'true'
  if (config.exposedHeaders.length > 0) {
    headers['Access-Control-Expose-Headers'] = config.exposedHeaders.join(', ')
  }

  return headers
}

/** The headers for a preflight, which is answered 204 and never reaches a route. */
export function preflightHeaders(config: CorsConfig, request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  if (origin === null) return {}

  const headers = originHeaders(config, origin)
  if (!('Access-Control-Allow-Origin' in headers)) return headers

  if (config.supportsCredentials) headers['Access-Control-Allow-Credentials'] = 'true'

  headers['Access-Control-Allow-Methods'] = config.allowedMethods.includes('*')
    ? (request.headers.get('access-control-request-method') ?? '').toUpperCase()
    : config.allowedMethods.map((method) => method.toUpperCase()).join(', ')

  const requested = request.headers.get('access-control-request-headers')

  if (config.allowedHeaders.includes('*')) {
    if (requested) headers['Access-Control-Allow-Headers'] = requested
  } else {
    headers['Access-Control-Allow-Headers'] = config.allowedHeaders.join(', ')
  }

  if (config.maxAge > 0) headers['Access-Control-Max-Age'] = String(config.maxAge)

  // The answer depends on both request headers, so both belong in Vary.
  headers.Vary = mergeVary(headers.Vary, 'Access-Control-Request-Method')

  return headers
}

/** `Access-Control-Allow-Origin`, plus `Vary` whenever the value is not constant. */
function originHeaders(config: CorsConfig, origin: string): Record<string, string> {
  const anyOrigin = config.allowedOrigins.includes('*')

  // Safe and cacheable: one answer for everybody.
  if (anyOrigin && !config.supportsCredentials) {
    return { 'Access-Control-Allow-Origin': '*' }
  }

  if (
    !anyOrigin &&
    config.allowedOrigins.length === 1 &&
    config.allowedOriginsPatterns.length === 0
  ) {
    const only = config.allowedOrigins[0] as string

    return only === origin ? { 'Access-Control-Allow-Origin': only } : { Vary: 'Origin' }
  }

  if (!isOriginAllowed(config, origin)) return { Vary: 'Origin' }

  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
}

function mergeVary(existing: string | undefined, header: string): string {
  if (!existing) return header

  const parts = existing.split(',').map((part) => part.trim())

  return parts.includes(header) ? existing : `${existing}, ${header}`
}
