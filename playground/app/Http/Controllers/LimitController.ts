import { controller, routeGroup } from '@elvel/core'
import { clientIp, limiters, throttle } from '@elvel/http'

/**
 * Generated with `artisan make:controller LimitController`, then extended.
 *
 * Rate limiting, CORS and trusted proxies, asserted by `scripts/smoke.ts` and
 * driven over the network with curl.
 *
 * Each limit lives in its own group. `throttle()` is scoped to the plugin it is
 * used in, so putting one on the controller itself would limit *every* route in
 * this file against one budget — which is how the first draft of this file
 * reported one limit's numbers for another limit's route.
 */
export default controller('limit')
  /** An inline limit: three requests, then 429 until the window closes. */
  .use(
    routeGroup()
      .use(throttle({ max: 3, decay: 60, prefix: 'probe:' }))
      .get('/check/limit/probe', () => ({ ok: true }))
  )

  /** A named limiter with two windows the request must satisfy at once. */
  .use(
    routeGroup()
      .use(throttle('uploads'))
      .get('/check/limit/uploads', () => ({ ok: true }))
  )

  /** An exemption stated out loud: localhost is unlimited here. */
  .use(
    routeGroup()
      .use(throttle('internal'))
      .get('/check/limit/internal', () => ({ ok: true }))
  )

  /** What the framework thinks the caller's address is. */
  .get('/check/limit/ip', ({ request, server }) => ({
    // Configured proxies only: an X-Forwarded-For from anyone else is ignored.
    ip: clientIp(request, server?.requestIP(request), { trustedProxies: [] }),
    trusting: clientIp(request, server?.requestIP(request), { trustedProxies: '*' }),
    forwarded: request.headers.get('x-forwarded-for')
  }))

  /** Which named limiters this application registered. */
  .get('/check/limit/registry', () => ({ limiters: limiters().names() }))

  /** A route inside the CORS paths, so the headers can be seen. */
  .get('/check/cors/ping', () => ({ pong: true }))
