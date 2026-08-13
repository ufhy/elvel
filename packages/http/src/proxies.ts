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
  /**
   * Which forwarding headers to believe. Every one, unless you say otherwise.
   *
   * The reason to narrow it is a proxy that does not send a header at all: AWS's
   * load balancer sends `X-Forwarded-For`, `-Proto` and `-Port` but never
   * `-Host`, so a client that sends its own `X-Forwarded-Host` would have it
   * believed — and host is what URL generation and password-reset links are built
   * from. `trustedHeaders: ['for', 'proto', 'port']` is Symfony's
   * `HEADER_X_FORWARDED_AWS_ELB` written out.
   */
  trustedHeaders?: readonly ForwardedHeader[]
}

/** The forwarding headers this package understands. */
export type ForwardedHeader = 'for' | 'proto' | 'host' | 'port' | 'prefix'

const ALL_HEADERS: readonly ForwardedHeader[] = ['for', 'proto', 'host', 'port', 'prefix']

/** Symfony's `HEADER_X_FORWARDED_AWS_ELB`: everything the balancer actually sends. */
export const AWS_ELB_HEADERS: readonly ForwardedHeader[] = ['for', 'proto', 'port']

function believes(options: ProxyOptions, header: ForwardedHeader): boolean {
  return (options.trustedHeaders ?? ALL_HEADERS).includes(header)
}

/** The first entry of a comma-separated forwarding header, from a trusted proxy. */
function forwarded(
  request: Request,
  socket: SocketAddress,
  options: ProxyOptions,
  header: ForwardedHeader
): string | undefined {
  if (!believes(options, header)) return undefined
  if (!isTrustedProxy(normalise(socket?.address ?? ''), options)) return undefined

  const value = request.headers.get(`x-forwarded-${header}`)
  if (value === null) return undefined

  const first = value.split(',')[0]?.trim()

  return first === undefined || first === '' ? undefined : first
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
  const claimed = forwarded(request, socket, options, 'for')

  return claimed === undefined ? direct : normalise(claimed)
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

  return forwarded(request, socket, options, 'proto') ?? fallback
}

/** The host the client asked for, honouring `X-Forwarded-Host` from a trusted proxy. */
export function clientHost(
  request: Request,
  socket: SocketAddress,
  options: ProxyOptions = {}
): string {
  const fallback = request.headers.get('host') ?? new URL(request.url).host

  return forwarded(request, socket, options, 'host') ?? fallback
}

/**
 * The path the application is mounted under, from `X-Forwarded-Prefix`.
 *
 * A gateway that routes `/api/orders` to this application's `/orders` strips the
 * prefix on the way in and sends it in this header. Without it every link the
 * application generates points at `/orders` — a URL that exists only inside the
 * cluster, so the redirect after a form submission 404s for everyone outside it.
 *
 * Empty string when there is no prefix, and never a trailing slash, so it can be
 * concatenated with a path that always starts with one.
 */
export function clientPrefix(
  request: Request,
  socket: SocketAddress,
  options: ProxyOptions = {}
): string {
  const prefix = forwarded(request, socket, options, 'prefix')
  if (prefix === undefined) return ''

  const trimmed = prefix.replace(/\/+$/, '')

  return trimmed === '' || trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * The port the client connected to, from `X-Forwarded-Port`.
 *
 * Needed because the socket's port is the one the proxy talks to — usually 8080
 * or a random container port — and building an absolute URL from it sends people
 * to an address that is not reachable from outside.
 */
export function clientPort(
  request: Request,
  socket: SocketAddress,
  options: ProxyOptions = {}
): number | undefined {
  const port = forwarded(request, socket, options, 'port')

  if (port !== undefined) {
    const parsed = Number.parseInt(port, 10)

    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed
  }

  // The host header can carry it too, and a proxy that sends `-Host` with a port
  // has already told us; falling back keeps the two answers consistent.
  const host = clientHost(request, socket, options)
  const separator = host.lastIndexOf(':')

  if (separator !== -1 && !host.includes(']', separator)) {
    const parsed = Number.parseInt(host.slice(separator + 1), 10)

    if (Number.isInteger(parsed)) return parsed
  }

  return clientProtocol(request, socket, options) === 'https' ? 443 : 80
}

/**
 * The absolute URL the client actually asked for, prefix and all.
 *
 * This is what a redirect to a named route, a signed URL, or a link in an email
 * has to be built from: everything the process itself can see describes the
 * inside of the cluster.
 */
export function clientUrl(
  request: Request,
  socket: SocketAddress,
  options: ProxyOptions = {}
): string {
  const protocol = clientProtocol(request, socket, options)
  const host = clientHost(request, socket, options)
  const port = clientPort(request, socket, options)
  const { pathname, search } = new URL(request.url)

  // Only when it is not the default for the scheme — a `:443` in a link is not
  // wrong, but it is the kind of detail people report as a bug.
  const standard = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80)
  const authority = host.includes(':') || standard ? host : `${host}:${port}`

  return `${protocol}://${authority}${clientPrefix(request, socket, options)}${pathname}${search}`
}
