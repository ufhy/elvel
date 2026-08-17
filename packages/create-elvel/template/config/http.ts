import { env } from '@elvel/core'

export default {
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
