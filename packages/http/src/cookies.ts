export type CookieOptions = {
  path?: string
  domain?: string
  maxAge?: number
  expires?: Date
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
}

/** The encryption an encrypted cookie needs. `@elvel/encryption` satisfies it. */
export type CookieEncrypter = {
  encryptString(value: string, context?: string): string
  decryptString(payload: string, context?: string): string
}

/**
 * Signed — and, when an encrypter is given, encrypted — cookies.
 *
 * A **signed** cookie stays readable by the client but cannot be changed without
 * the key. That is the right shape for the session cookie, which holds only an id.
 *
 * An **encrypted** cookie also hides its contents, and is what you want for
 * anything a client should not read. The cookie's *name* is bound into the
 * authentication tag, so a value cannot be moved from one cookie to another —
 * lifting `remember_token` into `session` has to fail, not merely look odd.
 */
export class CookieJar {
  constructor(
    private readonly key: string,
    private readonly encrypter?: CookieEncrypter
  ) {
    if (key.length < 16) {
      throw new Error('The cookie signing key must be at least 16 characters.')
    }
  }

  /** Can this jar encrypt, or only sign? */
  get encrypts(): boolean {
    return this.encrypter !== undefined
  }

  /**
   * Encrypt a value for a named cookie.
   *
   * The name is the context, not part of the plaintext: it is authenticated by the
   * tag, costs no bytes, and there is nothing to strip on the way back. Laravel
   * prefixes an HMAC of the name instead, because its payload format has nowhere
   * else to put it.
   */
  encrypt(name: string, value: string): string {
    if (!this.encrypter) {
      throw new Error(
        'This cookie jar cannot encrypt. Register EncryptionServiceProvider, or use sign().'
      )
    }

    return this.encrypter.encryptString(value, `cookie:${name}`)
  }

  /** Returns undefined when the cookie was tampered with, or was for another name. */
  decrypt(name: string, payload: string | undefined): string | undefined {
    if (!payload || !this.encrypter) return undefined

    try {
      return this.encrypter.decryptString(payload, `cookie:${name}`)
    } catch {
      // A cookie that does not authenticate is treated as absent, which is what
      // lets a key rotation or a stale cookie degrade into "log in again".
      return undefined
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
