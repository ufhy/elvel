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
    .filter((proxy) => proxy !== '')
}
