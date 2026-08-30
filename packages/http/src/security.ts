/**
 * The headers a browser needs before it will refuse anything on your behalf.
 *
 * Measured across every package before this existed: no
 * `Content-Security-Policy`, no `Strict-Transport-Security`, no
 * `X-Frame-Options`, no `Referrer-Policy`, no `X-Content-Type-Options`. Not one.
 * Each is a decision a framework can take correctly once, and each is a question
 * an auditor asks by name.
 */
export type ContentSecurityPolicy = {
  /**
   * Directives, as source lists. `false` drops one the defaults set.
   *
   * ```ts
   * csp: { directives: { 'img-src': ["'self'", 'https://cdn.example.com'] } }
   * ```
   */
  directives?: Record<string, string[] | false>

  /**
   * Send `Content-Security-Policy-Report-Only` instead.
   *
   * How a policy is introduced to an application that already exists: the browser
   * reports what the policy *would* have blocked and blocks nothing. A policy
   * enabled blind on a page nobody tested is a page that renders without its
   * JavaScript, which is worse than no policy at all.
   */
  reportOnly?: boolean
}

export type SecurityConfig = {
  /** Turn every header here off at once — for an application behind something else. */
  enabled?: boolean

  /** `X-Frame-Options`. `frame-ancestors` covers modern browsers; this covers the rest. */
  frameOptions?: string | false

  /** `X-Content-Type-Options: nosniff` — stops a browser guessing a type it was told. */
  contentTypeOptions?: boolean

  referrerPolicy?: string | false

  /** `Permissions-Policy` — the features a page is not asking for. */
  permissionsPolicy?: string | false

  crossOriginOpenerPolicy?: string | false

  /**
   * HSTS, and only over TLS.
   *
   * Sent in production only, because a browser ignores it over plain HTTP anyway
   * and sending it in development would pin `localhost` to HTTPS in the developer's
   * browser — a state that outlives the project and is remembered per host.
   */
  hsts?: { maxAge: number; includeSubDomains?: boolean; preload?: boolean } | false

  csp?: ContentSecurityPolicy | false
}

/**
 * What a framework-rendered page needs, and nothing it does not.
 *
 * `style-src` allows inline styles because a view is allowed to carry its own —
 * the scaffold's landing page does, for the reason Laravel's `welcome.blade.php`
 * does: a stylesheet request before the first paint is a flash of unstyled text.
 * Scripts get no such allowance; an inline script carries the request's nonce
 * instead, which is a per-response secret an injected script cannot guess.
 */
const DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'connect-src': ["'self'"],
  'font-src': ["'self'", 'data:'],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'img-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"]
}

const DEFAULTS: Required<Omit<SecurityConfig, 'csp' | 'hsts' | 'enabled'>> & {
  hsts: { maxAge: number; includeSubDomains: boolean; preload: boolean }
} = {
  frameOptions: 'DENY',
  contentTypeOptions: true,
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: 'camera=(), microphone=(), geolocation=()',
  crossOriginOpenerPolicy: 'same-origin',
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false }
}

export type SecurityContext = {
  /** Production, roughly: whether HSTS is worth sending. */
  secure: boolean

  /** This response's nonce, which the policy names and a view can render. */
  nonce?: string

  /**
   * The Vite dev server's origin, while one is running.
   *
   * Without it a policy that is correct in production blocks every module in
   * development — the dev server is another origin, and the HMR socket is another
   * scheme. Adding it here is what lets the same policy be tested by the person
   * writing the page rather than by the deploy.
   */
  devOrigin?: string
}

/** Build one directive's value, with the nonce and dev server folded in. */
function sources(
  name: string,
  configured: string[],
  { nonce, devOrigin }: SecurityContext
): string[] {
  const extra: string[] = []

  if (name === 'script-src' && nonce !== undefined) extra.push(`'nonce-${nonce}'`)

  if (devOrigin !== undefined) {
    if (name === 'script-src' || name === 'style-src' || name === 'font-src') {
      extra.push(devOrigin)
    }

    /**
     * The socket, as `ws:` and `wss:` both.
     *
     * Vite's client connects over WebSocket for hot updates, and the scheme is
     * decided by how the dev server was reached — so naming only one of them
     * leaves a page that loads and never updates, which looks like a broken
     * watcher rather than a blocked connection.
     */
    if (name === 'connect-src') {
      extra.push(devOrigin, devOrigin.replace(/^http/, 'ws'))
    }
  }

  return [...configured, ...extra]
}

/** `Content-Security-Policy`, or undefined when there is nothing to say. */
export function contentSecurityPolicy(
  policy: ContentSecurityPolicy,
  context: SecurityContext
): string | undefined {
  const merged: Record<string, string[] | false> = { ...DIRECTIVES, ...policy.directives }

  const written = Object.entries(merged)
    .filter(([, value]) => value !== false)
    .map(([name, value]) => [name, sources(name, value as string[], context)] as const)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name} ${value.join(' ')}`)

  return written.length === 0 ? undefined : written.join('; ')
}

/**
 * Every security header this response should carry.
 *
 * Returned as a map rather than written onto a response, because there are two
 * places that have to write them: the handler path, and the error path — which
 * runs no handler hooks at all and would otherwise answer a page with none of
 * this. That split is the reason `request.lifecycle` exists.
 */
export function securityHeaders(
  config: SecurityConfig,
  context: SecurityContext
): Record<string, string> {
  const headers: Record<string, string> = {}
  const frameOptions = config.frameOptions ?? DEFAULTS.frameOptions
  const referrerPolicy = config.referrerPolicy ?? DEFAULTS.referrerPolicy
  const permissionsPolicy = config.permissionsPolicy ?? DEFAULTS.permissionsPolicy
  const opener = config.crossOriginOpenerPolicy ?? DEFAULTS.crossOriginOpenerPolicy

  if ((config.contentTypeOptions ?? DEFAULTS.contentTypeOptions) !== false) {
    headers['x-content-type-options'] = 'nosniff'
  }

  if (frameOptions !== false) headers['x-frame-options'] = frameOptions
  if (referrerPolicy !== false) headers['referrer-policy'] = referrerPolicy
  if (permissionsPolicy !== false) headers['permissions-policy'] = permissionsPolicy
  if (opener !== false) headers['cross-origin-opener-policy'] = opener

  const hsts = config.hsts === undefined ? DEFAULTS.hsts : config.hsts

  if (hsts !== false && context.secure) {
    const parts = [`max-age=${hsts.maxAge}`]

    if (hsts.includeSubDomains !== false) parts.push('includeSubDomains')
    if (hsts.preload === true) parts.push('preload')

    headers['strict-transport-security'] = parts.join('; ')
  }

  if (config.csp !== false) {
    const policy = contentSecurityPolicy(config.csp ?? {}, context)

    if (policy !== undefined) {
      const name =
        config.csp?.reportOnly === true
          ? 'content-security-policy-report-only'
          : 'content-security-policy'

      headers[name] = policy
    }
  }

  return headers
}

/**
 * The headers, prepared once, with only the nonce left to fill in.
 *
 * Everything a response carries is fixed at boot except one substring: the
 * `'nonce-…'` inside `script-src`. Rebuilding all of it per response cost 3.2µs
 * of the security plugin's 5.0µs — measured by swapping the live build for a
 * constant map and remeasuring, which left the hook itself at 0.4µs and the seven
 * header writes at 1.4µs. Ninety percent of the rebuild was the CSP string.
 *
 * So the policy is built once and cut in two around where the nonce goes, and a
 * response joins three strings instead of spreading a map, filtering it twice,
 * mapping it twice and joining it.
 *
 * Development keeps the old path. `devOrigin` changes the policy while Vite is
 * running and is read from a file per response anyway, so there is nothing to
 * precompute and nothing to gain.
 *
 * `write` rather than a returned map, because the caller sets headers one at a
 * time and a map would be an allocation per response to read once.
 */
export function securityHeaderWriter(
  config: SecurityConfig,
  secure: boolean
): (
  nonce: string | undefined,
  devOrigin: string | undefined,
  write: (name: string, value: string) => void
) => void {
  const fixed = Object.entries(
    securityHeaders(config, { secure, nonce: undefined, devOrigin: undefined })
  )

  const cspName =
    config.csp !== false && config.csp?.reportOnly === true
      ? 'content-security-policy-report-only'
      : 'content-security-policy'

  /**
   * The policy with a nonce in it, cut where the nonce sits.
   *
   * Built by asking for one with a marker rather than by assembling the string
   * here: the directive order, the merging of defaults and the filtering all stay
   * in one place, and this cannot drift from it.
   */
  const MARKER = "'nonce-\u0000MARKER\u0000'"
  const withNonce = securityHeaders(config, {
    secure,
    nonce: '\u0000MARKER\u0000',
    devOrigin: undefined
  })[cspName]

  const cut = withNonce?.indexOf(MARKER) ?? -1
  const prefix = cut >= 0 ? (withNonce as string).slice(0, cut) : undefined
  const suffix = cut >= 0 ? (withNonce as string).slice(cut + MARKER.length) : undefined

  return (nonce, devOrigin, write) => {
    if (devOrigin !== undefined) {
      for (const [name, value] of Object.entries(
        securityHeaders(config, { secure, nonce, devOrigin })
      )) {
        write(name, value)
      }

      return
    }

    for (const [name, value] of fixed) {
      if (name === cspName && nonce !== undefined && prefix !== undefined) {
        write(name, `${prefix}'nonce-${nonce}'${suffix}`)
        continue
      }

      write(name, value)
    }
  }
}

/**
 * A nonce for one response.
 *
 * Base64 of 16 random bytes, which is what the CSP specification asks for: enough
 * entropy that an injected script cannot guess it, regenerated per response so a
 * leaked one is worth nothing.
 */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
}
