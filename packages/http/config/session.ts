import { env } from '@elvel/core'

export default {
  /** Turn the session middleware off entirely for a pure API. */
  enabled: env('SESSION_ENABLED', true),

  /** `file` or `memory`. */
  driver: env('SESSION_DRIVER', 'file'),

  /** Where the file driver writes. Defaults to storage/framework/sessions. */
  path: undefined,

  cookie: env('SESSION_COOKIE', 'elvel_session'),

  /**
   * `Lax` or `Strict`, and what the difference costs.
   *
   * `Lax` attaches the cookie to a top-level navigation from another site, which
   * is what makes a link in an email land signed in. `Strict` refuses even that —
   * safer, and visible to anybody arriving by link, which is why it is a choice
   * rather than the default.
   *
   * `HttpOnly` is not here on purpose: it is always on. A session cookie a script
   * can read is a session an injected script can steal.
   */
  sameSite: env('SESSION_SAME_SITE', 'lax'),

  /**
   * Sent over TLS only.
   *
   * Defaults to on in production. Configurable because a development setup can be
   * HTTPS and a production one can sit behind a proxy that terminates it — but a
   * cookie sent over plain HTTP in production is a cookie on the wire.
   */
  secure: env('SESSION_SECURE', undefined),

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
   * The session cookie holds only an opaque id, so signing it is enough — never
   * put anything secret in a cookie. Add `@elvel/encryption` and set
   * `encrypt: true` here to encrypt it as well.
   */
  csrf: env('SESSION_CSRF', true),

  /** Paths exempt from CSRF. A trailing `*` matches a prefix. */
  csrfExcept: ['/api/*']
}
