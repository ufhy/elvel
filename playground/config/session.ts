import { env } from '@elysian/core'

export default {
  /** Turn the session middleware off entirely for a pure API. */
  enabled: env('SESSION_ENABLED', true),

  /** `file` or `memory`. */
  driver: env('SESSION_DRIVER', 'file'),

  /** Where the file driver writes. Defaults to storage/framework/sessions. */
  path: undefined,

  cookie: env('SESSION_COOKIE', 'elysian_session'),

  /** Seconds. */
  lifetime: Number(env('SESSION_LIFETIME', 7200)),

  /**
   * CSRF protection for state-changing requests.
   *
   * The session cookie holds only a signed id, so it is signed rather than
   * encrypted — never put anything secret in a cookie.
   */
  csrf: env('SESSION_CSRF', true),

  /** Paths exempt from CSRF. A trailing `*` matches a prefix. */
  csrfExcept: ['/api/*', '/check/*']
}
