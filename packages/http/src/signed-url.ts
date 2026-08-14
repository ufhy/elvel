import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'
import { app, HttpException } from '@elysian/core'
import { route } from './route-helpers.ts'

/** 403, for a URL whose signature does not hold. */
export class InvalidSignatureError extends HttpException {
  constructor(message = 'Invalid signature.') {
    super(403, message)
    this.name = 'InvalidSignatureError'
  }
}

/** The query parameters a signature adds. */
const SIGNATURE = 'signature'
const EXPIRES = 'expires'

function key(): string {
  const secret = app().config.get<string>('app.key', '')

  if (secret === '') {
    throw new Error('Signing a URL needs APP_KEY. Run: artisan key:generate')
  }

  return secret
}

/**
 * What gets signed: the URL with its parameters in a fixed order.
 *
 * Sorted, because a query string is a set and a signature is over bytes. Without
 * sorting, `?a=1&b=2` and `?b=2&a=1` are the same request with different
 * signatures, and any client or proxy that reorders parameters breaks the link.
 * The signature itself is removed first — it cannot be part of what it covers.
 */
function payload(url: URL): string {
  const parameters = new URLSearchParams(url.searchParams)
  parameters.delete(SIGNATURE)

  const sorted = [...parameters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = new URLSearchParams(sorted).toString()

  return `${url.origin}${url.pathname}${query === '' ? '' : `?${query}`}`
}

function sign(url: URL): string {
  return createHmac('sha256', key()).update(payload(url)).digest('hex')
}

/**
 * A URL nobody can alter — Laravel's `URL::signedRoute`.
 *
 * ```ts
 * signedRoute('unsubscribe', { list: 7 })
 * temporarySignedRoute('invite.accept', 3600, { token })
 * ```
 *
 * The point is a link that can be handed to somebody without a session: an
 * unsubscribe link in an email, an invitation, a one-time download. The
 * signature covers the path and every parameter, so changing `list=7` to
 * `list=8` invalidates it.
 */
export function signedUrl(url: string, expiresInSeconds?: number): string {
  const built = new URL(url, app().config.get<string>('app.url', 'http://localhost'))

  if (expiresInSeconds !== undefined) {
    built.searchParams.set(EXPIRES, String(Math.floor(Date.now() / 1000) + expiresInSeconds))
  }

  built.searchParams.set(SIGNATURE, sign(built))

  return built.toString()
}

export function signedRoute(
  name: string,
  parameters: Record<string, unknown> = {},
  expiresInSeconds?: number
): string {
  return signedUrl(route(name, parameters, true), expiresInSeconds)
}

export function temporarySignedRoute(
  name: string,
  expiresInSeconds: number,
  parameters: Record<string, unknown> = {}
): string {
  return signedRoute(name, parameters, expiresInSeconds)
}

/** Does this request carry a signature that covers it, and has it not expired? */
export function hasValidSignature(request: Request, absolute = true): boolean {
  const url = new URL(request.url)
  const provided = url.searchParams.get(SIGNATURE)

  if (!provided) return false

  const expires = url.searchParams.get(EXPIRES)
  if (expires !== null) {
    const at = Number(expires)
    if (!Number.isFinite(at) || at * 1000 < Date.now()) return false
  }

  /**
   * `absolute: false` signs the path and query only.
   *
   * For an application behind a proxy that rewrites the host, or one reachable
   * on more than one hostname, a signature over the origin fails on the second
   * hostname even though nothing was tampered with.
   */
  const target = absolute ? url : new URL(`${url.pathname}${url.search}`, 'http://signature.local')

  const expected = sign(target)

  return timingSafeCompare(provided, expected)
}

/**
 * Compared in constant time.
 *
 * A byte-by-byte comparison that returns early leaks how much of a guess was
 * right, which is enough to find a signature one character at a time.
 */
function timingSafeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)

  if (left.length !== right.length) return false

  return nodeTimingSafeEqual(left, right)
}
