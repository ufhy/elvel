import { env } from '@elyvel/core'

/**
 * Cross-origin resource sharing.
 *
 * `paths` is the switch: nothing outside it gets a CORS header at all, which is
 * why the default is an API prefix rather than everything.
 */
export default {
  paths: ['api/*', 'check/cors/*'],

  allowedMethods: ['*'],

  /**
   * `*` is fine while nothing is credentialed. Name your origins before turning
   * `supportsCredentials` on — a browser refuses `*` on a credentialed request,
   * and the framework then echoes the caller's own origin instead.
   */
  allowedOrigins: env('CORS_ORIGINS', '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ''),

  /** Regular expressions, for `https://<anything>.example.com`. */
  allowedOriginsPatterns: ['^https://[a-z0-9-]+\\.example\\.com$'],

  allowedHeaders: ['*'],

  /** Headers the browser is allowed to read off the response. */
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],

  /** Seconds a browser may cache the preflight. */
  maxAge: 600,

  supportsCredentials: env('CORS_CREDENTIALS', false)
}
