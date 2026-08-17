import { env } from '@elvel/core'

/**
 * Cross-origin resource sharing.
 *
 * `paths` is the switch, and it starts empty: nothing gets a CORS header until
 * you say which routes are meant to be called from a browser somewhere else.
 */
export default {
  paths: ['api/*'],

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

  /** Regular expressions, for `https://<tenant>.example.com`. */
  allowedOriginsPatterns: [] as string[],

  allowedHeaders: ['*'],

  /** Headers the browser is allowed to read off the response. */
  exposedHeaders: [] as string[],

  /** Seconds a browser may cache the preflight. */
  maxAge: 0,

  supportsCredentials: env('CORS_CREDENTIALS', false)
}
