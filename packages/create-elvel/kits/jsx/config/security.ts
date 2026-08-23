import { env } from '@elvel/core'

/**
 * The headers a browser needs before it will refuse anything on your behalf.
 *
 * All of them are on by default. Each is a decision that can be taken correctly
 * once, and each is a question an auditor asks by name — so the framework answers
 * them and this file is where you disagree.
 */
export default {
  /** Everything here off at once, for an application behind something that does it. */
  enabled: env('SECURITY_HEADERS', true),

  /**
   * `X-Frame-Options`, which stops your pages being framed.
   *
   * `frame-ancestors` in the policy below is the modern form and covers more; this
   * is for browsers that never learned it. `SAMEORIGIN` if you frame your own
   * pages, and remember to loosen `frame-ancestors` too.
   */
  frameOptions: 'DENY',

  /** `nosniff` — a browser must not guess a type it was already told. */
  contentTypeOptions: true,

  /**
   * How much of the current URL travels to another site.
   *
   * `strict-origin-when-cross-origin` sends the full URL to your own pages, the
   * origin alone to other sites, and nothing at all when leaving HTTPS for HTTP.
   * A URL is not a secret and often carries one anyway — an invitation token, a
   * password reset, a document id.
   */
  referrerPolicy: 'strict-origin-when-cross-origin',

  /** Features this application does not ask for, refused before it can. */
  permissionsPolicy: 'camera=(), microphone=(), geolocation=()',

  /** Cuts the window opener link, so a page you link to cannot reach back. */
  crossOriginOpenerPolicy: 'same-origin',

  /**
   * HSTS, sent in production only.
   *
   * A browser ignores it over plain HTTP, and sending it in development would pin
   * `localhost` to HTTPS in the developer's browser — remembered per host, and
   * outliving the project that did it.
   *
   * `preload: true` submits to a browser-shipped list and is close to permanent.
   * Turn it on when the domain is certain, not before.
   */
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: false
  },

  /**
   * Content Security Policy — the one that actually stops an injected script.
   *
   * Only the directives you name are changed; the rest keep the framework's
   * defaults, which are `'self'` for everything, `'none'` for objects and framing,
   * and `data:` for images and fonts. `false` drops a directive entirely.
   *
   * ```ts
   * csp: { directives: { 'img-src': ["'self'", 'https://cdn.example.com'] } }
   * ```
   *
   * **Inline scripts need the request's nonce.** `script-src` allows no inline
   * script, because allowing them is allowing the injected one. What a page needs
   * this early — deciding a theme before the first paint — renders as
   * `<script nonce={cspNonce()}>`, and the policy names that nonce. Inline
   * *styles* are allowed: a view is allowed to carry its own, and a stylesheet
   * request before the first paint is a flash of unstyled text.
   *
   * `reportOnly: true` is how a policy is introduced to an application that
   * already exists — the browser reports what it would have blocked and blocks
   * nothing.
   */
  csp: {
    /**
     * The font this kit's layout asks for, named because the policy asks it to be.
     *
     * Measured with the defaults alone: `Loading the stylesheet
     * 'https://fonts.bunny.net/css?family=instrument-sans' violates the following
     * Content Security Policy directive: "style-src 'self'"` — the page rendered
     * in a fallback font and nothing on it said why. A policy is only worth having
     * if what the application genuinely loads is written down, and this is what
     * writing it down looks like.
     */
    directives: {
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.bunny.net'],
      'font-src': ["'self'", 'data:', 'https://fonts.bunny.net']
    },
    reportOnly: env('SECURITY_CSP_REPORT_ONLY', false)
  }
}
