/**
 * Where a request really came from, when something sits in front of us.
 *
 * `X-Forwarded-For` is a header, which means anyone can send one. Behind a load
 * balancer you must read it — every request otherwise appears to come from the
 * balancer, and one rate limit is shared by the whole internet. Directly exposed
 * you must not — a client that sets its own `X-Forwarded-For` gets a fresh
 * identity per request and walks around the limit.
 *
 * So it is trusted only from a proxy you named. `trustedProxies: '*'` says "I am
 * always behind one", which is the honest form of the same decision.
 */
export type ProxyOptions = {
  /** Addresses whose forwarding headers are believed, or `'*'` for any. */
  trustedProxies?: string[] | '*'
}

/** The address Elysia saw, before any header is considered. */
export type SocketAddress = { address: string } | null | undefined

export function isTrustedProxy(address: string | undefined, options: ProxyOptions): boolean {
  const trusted = options.trustedProxies

  if (trusted === undefined || (Array.isArray(trusted) && trusted.length === 0)) return false
  if (trusted === '*') return true
  if (address === undefined) return false

  return trusted.includes(address)
}

/**
 * The client's address: the socket's, or the first entry of `X-Forwarded-For`
 * when the socket belongs to a proxy we trust.
 *
 * The **first** entry, because the chain reads client, then each proxy in turn —
 * and everything after the first is appended by infrastructure rather than sent
 * by the client.
 */
export function clientIp(
  request: Request,
  socket: SocketAddress,
  options: ProxyOptions = {}
): string {
  const direct = normalise(socket?.address ?? '')

  if (!isTrustedProxy(direct, options)) return direct

  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded === null) return direct

  const first = forwarded.split(',')[0]?.trim()

  return first === undefined || first === '' ? direct : normalise(first)
}

/**
 * `::ffff:127.0.0.1` is `127.0.0.1`.
 *
 * Bun reports an IPv4 client through an IPv6 socket in the mapped form, so a
 * limiter written as `ip === '127.0.0.1'` silently never matches — and an
 * exemption that never fires is worse than no exemption, because it looks like
 * one. Normalising here rather than asking every caller to remember.
 */
function normalise(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)

  return mapped?.[1] ?? address
}

/** The scheme the client used, honouring `X-Forwarded-Proto` from a trusted proxy. */
export function clientProtocol(
  request: Request,
  socket: SocketAddress,
  options: ProxyOptions = {}
): string {
  const fallback = new URL(request.url).protocol.replace(':', '')

  if (!isTrustedProxy(socket?.address ?? '', options)) return fallback

  const forwarded = request.headers.get('x-forwarded-proto')

  return forwarded === null ? fallback : (forwarded.split(',')[0]?.trim() ?? fallback)
}

/** The host the client asked for, honouring `X-Forwarded-Host` from a trusted proxy. */
export function clientHost(
  request: Request,
  socket: SocketAddress,
  options: ProxyOptions = {}
): string {
  const fallback = request.headers.get('host') ?? new URL(request.url).host

  if (!isTrustedProxy(socket?.address ?? '', options)) return fallback

  const forwarded = request.headers.get('x-forwarded-host')

  return forwarded === null ? fallback : (forwarded.split(',')[0]?.trim() ?? fallback)
}
