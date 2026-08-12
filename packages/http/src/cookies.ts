export type CookieOptions = {
  path?: string
  domain?: string
  maxAge?: number
  expires?: Date
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
}

/**
 * Signed cookies.
 *
 * These are **signed, not encrypted**: the value stays readable by the client,
 * but it cannot be changed without the key. Laravel encrypts, which also hides
 * the value — that needs an encryption package we have not built, so this is
 * stated plainly rather than implied.
 *
 * Never put anything secret in one. The session cookie holds only an id.
 */
export class CookieJar {
  constructor(private readonly key: string) {
    if (key.length < 16) {
      throw new Error('The cookie signing key must be at least 16 characters.')
    }
  }

  /** `value|signature` */
  sign(value: string): string {
    return `${value}|${this.signature(value)}`
  }

  /** Returns undefined when the signature is missing or wrong. */
  unsign(signed: string | undefined): string | undefined {
    if (!signed) return undefined

    const separator = signed.lastIndexOf('|')
    if (separator === -1) return undefined

    const value = signed.slice(0, separator)
    const provided = signed.slice(separator + 1)

    return timingSafeEqual(provided, this.signature(value)) ? value : undefined
  }

  private signature(value: string): string {
    return new Bun.CryptoHasher('sha256', this.key).update(value).digest('base64url')
  }

  /** Render a `Set-Cookie` header value. */
  static serialize(name: string, value: string, options: CookieOptions = {}): string {
    const parts = [`${name}=${encodeURIComponent(value)}`]

    parts.push(`Path=${options.path ?? '/'}`)
    if (options.domain) parts.push(`Domain=${options.domain}`)
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
    if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
    if (options.httpOnly !== false) parts.push('HttpOnly')
    if (options.secure) parts.push('Secure')
    parts.push(`SameSite=${capitalise(options.sameSite ?? 'lax')}`)

    return parts.join('; ')
  }

  /** Parse a request `Cookie` header. */
  static parse(header: string | null | undefined): Record<string, string> {
    if (!header) return {}

    const cookies: Record<string, string> = {}

    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=')
      if (separator === -1) continue

      const name = pair.slice(0, separator).trim()
      if (name === '') continue

      cookies[name] = decodeURIComponent(pair.slice(separator + 1).trim())
    }

    return cookies
  }
}

/**
 * Constant-time string comparison.
 *
 * `===` on a signature leaks its length and prefix through timing, which is the
 * whole reason Laravel uses `hash_equals`.
 */
export function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)

  if (a.length !== b.length) return false

  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= (a[index] as number) ^ (b[index] as number)
  }

  return mismatch === 0
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
