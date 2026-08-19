import { env } from '@elvel/core'

export default {
  /** Turn the session middleware off entirely for a pure API. */
  enabled: env('SESSION_ENABLED', true),

  /** `file` or `memory`. */
  driver: env('SESSION_DRIVER', 'file'),

  /** Where the file driver writes. Defaults to storage/framework/sessions. */
  path: undefined,

  cookie: env('SESSION_COOKIE', 'elvel_session'),

  /** Seconds. */
  lifetime: Number(env('SESSION_LIFETIME', 7200)),

  /**
   * Where sessions are kept: `file`, `database`, `redis`, `cache` or `memory`.
   *
   * `file` is right for one machine and wrong for two: the session lives on
   * whichever container wrote it, so behind a load balancer people are logged out
   * at random. `database` needs `elvel session:table && elvel migrate`.
   */
  table: env('SESSION_TABLE', 'sessions'),

  /** Connection for the database driver. Undefined means the app's default. */
  connection: undefined,

  /** Cache store for the redis/cache driver. Undefined means the default store. */
  store: env('SESSION_STORE', '') || undefined,

  /**
   * CSRF protection for state-changing requests.
   *
   * The session cookie holds only a signed id, so it is signed rather than
   * encrypted — never put anything secret in a cookie.
   */
  csrf: env('SESSION_CSRF', true),

  /**
   * Encrypt the session cookie instead of only signing it.
   *
   * Signing is enough for what it holds — an opaque id — so this is off by
   * default; turning it on also hides the id from anything reading the browser's
   * storage. Needs the encryption package.
   */
  encrypt: env('SESSION_ENCRYPT', false),

  /** Paths exempt from CSRF. A trailing `*` matches a prefix. */
  csrfExcept: ['/api/*', '/check/*', '/signal/*']
}
