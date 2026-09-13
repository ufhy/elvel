import { env } from '@elvel/core'

export default {
  /**
   * Refuse to start on a port somebody else holds.
   *
   * On Windows a second bind to the same port **succeeds** — `SO_REUSEADDR`
   * permits it — so two servers listen and requests go to whichever socket wins.
   * What that looks like from a terminal is a server that cannot be killed: Ctrl+C
   * returns the prompt, the next start reports success, and the old process keeps
   * answering.
   *
   * Turn it off for a deliberate `reusePort` cluster, where several processes on
   * one port is the point.
   */
  checkPort: env('HTTP_CHECK_PORT', true),

  /**
   * Proxies whose `X-Forwarded-*` headers are believed.
   *
   * Empty means none: the socket address is the client. Behind a load balancer
   * this must name it (or be `'*'`), or every request looks like it came from the
   * balancer and one rate limit is shared by everybody. Directly exposed it must
   * stay empty, or a caller can forge the header and get a fresh identity per
   * request — a rate limit that counts nothing.
   */
  trustedProxies: env('TRUSTED_PROXIES', '')
    .split(',')
    .map((proxy) => proxy.trim())
    .filter((proxy) => proxy !== ''),

  /**
   * Hosts this application answers for.
   *
   * The `Host` header decides every generated URL — a password-reset link, a
   * signed URL, an absolute `route()` — so a request carrying somebody else's
   * host produces a reset link pointing there, mailed to the account's owner.
   *
   * Empty falls back to the host in `app.url`, plus localhost so a development
   * machine is not locked out by its own default. `*.example.com` matches one
   * level and not the apex.
   */
  trustedHosts: env('TRUSTED_HOSTS', '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== ''),

  /**
   * Largest request body, in bytes. `0` turns the check off.
   *
   * A declared `Content-Length` over it is refused before a byte is read; a
   * chunked body is counted and cut off the moment it passes.
   */
  maxBodySize: Number(process.env.HTTP_MAX_BODY_SIZE ?? 10 * 1024 * 1024),

  /** Paths allowed to exceed it — an upload endpoint. A trailing `*` is a prefix. */
  maxBodySizeExcept: [] as string[],

  /**
   * What every cookie gets unless its call site says otherwise.
   *
   * `secure` empty follows the environment: on in production, off elsewhere, the
   * same rule the session cookie already uses. A cookie sent over plain HTTP in
   * production is a cookie on the wire, and a call site that forgets the flag is
   * how that happens.
   *
   * `domain` matters for a deployment spanning subdomains: set it once here
   * rather than at every call that queues a cookie.
   */
  cookie: {
    path: env('COOKIE_PATH', '/'),
    domain: env('COOKIE_DOMAIN', '') || undefined,
    secure: env('COOKIE_SECURE', undefined) as boolean | undefined,
    sameSite: env('COOKIE_SAME_SITE', 'lax') as 'strict' | 'lax' | 'none'
  }
}
