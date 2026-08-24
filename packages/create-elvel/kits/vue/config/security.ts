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
     * The font the client's stylesheet asks for, named because the policy asks it
     * to be.
     *
     * `shadcn-vue init` writes `@import url('https://fonts.googleapis.com/...')` at
     * the top of `frontend/src/style.css`; this kit points that at bunny.net
     * instead, which mirrors the same faces and sets no cookies. Either way the
     * host has to appear here: with the defaults alone the browser refuses the
     * stylesheet — `violates the following Content Security Policy directive:
     * "style-src 'self'"` — and the page renders in a fallback font with nothing on
     * it saying why.
     *
     * Switch the stylesheet to a system font stack and both of these lines can go.
     */
    directives: {
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.bunny.net'],
      'font-src': ["'self'", 'data:', 'https://fonts.bunny.net']
    },
    reportOnly: env('SECURITY_CSP_REPORT_ONLY', false)
  }
}
