import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { deriveKey } from './keys.ts'

/** Thrown when a value cannot be encrypted. */
export class EncryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptError'
  }
}

/**
 * Thrown when a payload cannot be decrypted.
 *
 * One error for every reason — a bad tag, the wrong context, a truncated payload,
 * an unknown version — on purpose. Telling a caller *why* a ciphertext was
 * rejected is how padding-oracle attacks start, and there is nothing a legitimate
 * caller does differently in each case.
 */
export class DecryptError extends Error {
  constructor(message = 'Could not decrypt the payload.') {
    super(message)
    this.name = 'DecryptError'
  }
}

/** Bytes of nonce. Twelve is what GCM is specified for. */
const IV_BYTES = 12

/** Bytes of authentication tag. */
const TAG_BYTES = 16

const VERSION = 'v1'

export type EncrypterOptions = {
  /**
   * Keys this encrypter will still *read*, for rotation.
   *
   * Put the old `APP_KEY` here after changing it, and existing cookies and rows
   * keep working while new ones are written with the new key.
   */
  previousKeys?: string[]
  /** Label mixed into the key derivation. Change it and every payload is unreadable. */
  purpose?: string
}

/**
 * AES-256-GCM, synchronously.
 *
 * Three decisions worth stating, because they are departures from Laravel:
 *
 * **GCM only, no CBC.** GCM is AEAD: one operation encrypts and authenticates, so
 * there is no separate MAC to compute, order, or forget to compare in constant
 * time. Laravel keeps CBC for payloads written by older versions of itself; we
 * have no such history to honour.
 *
 * **A versioned, compact payload** — `v1.<iv>.<ciphertext‖tag>` in base64url —
 * rather than base64 of a JSON object. It is shorter, which matters inside a 4 KB
 * cookie, it is URL-safe, and nothing about an untrusted payload is parsed as JSON
 * before its tag has been verified.
 *
 * **Synchronous**, via `node:crypto` rather than WebCrypto. Not a style choice: the
 * model cast pipeline is synchronous, so an async-only encrypter could not back an
 * `encrypted` cast at all.
 */
export class Encrypter {
  private readonly keys: Buffer[]

  constructor(secret: string, options: EncrypterOptions = {}) {
    const purpose = options.purpose ?? 'elysian:encrypt:v1'

    // The primary key is first: it is what writes, and what reads are tried
    // against first.
    this.keys = [secret, ...(options.previousKeys ?? [])].map((key) => deriveKey(key, purpose))
  }

  /**
   * Encrypt any JSON-serialisable value.
   *
   * `context` is bound into the authentication tag, not into the plaintext. A
   * payload encrypted for one context cannot be decrypted as another — which is
   * what stops a cookie being replayed under a different name, or a queue payload
   * being fed to a different job. Laravel achieves the same by prefixing an HMAC of
   * the name to the plaintext and stripping it afterwards; AAD is the mechanism
   * that exists for it.
   */
  encrypt(value: unknown, context?: string): string {
    let serialised: string

    try {
      serialised = JSON.stringify(value ?? null)
    } catch (error) {
      throw new EncryptError(
        `Could not encrypt the value: it is not JSON-serialisable (${(error as Error).message}).`
      )
    }

    return this.encryptString(serialised, context)
  }

  /** Encrypt a string, without a JSON round trip. */
  encryptString(value: string, context?: string): string {
    const iv = randomBytes(IV_BYTES)
    const key = this.keys[0] as Buffer

    const cipher = createCipheriv('aes-256-gcm', key, iv)
    if (context !== undefined) cipher.setAAD(new TextEncoder().encode(context))

    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return [VERSION, base64url(iv), base64url(Buffer.concat([ciphertext, tag]))].join('.')
  }

  /** Decrypt a value written by `encrypt`. */
  decrypt<T = unknown>(payload: string, context?: string): T {
    const text = this.decryptString(payload, context)

    try {
      return JSON.parse(text) as T
    } catch {
      // The tag already proved this came from us, so unparseable JSON means the
      // payload was written by `encryptString` and read by the wrong method.
      throw new DecryptError('Decrypted the payload, but it does not contain JSON.')
    }
  }

  /** Decrypt a string written by `encryptString`. */
  decryptString(payload: string, context?: string): string {
    if (typeof payload !== 'string') throw new DecryptError()

    const parts = payload.split('.')

    if (parts.length !== 3 || parts[0] !== VERSION) throw new DecryptError()

    const iv = fromBase64url(parts[1] as string)
    const body = fromBase64url(parts[2] as string)

    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new DecryptError()

    const ciphertext = body.subarray(0, body.length - TAG_BYTES)
    const tag = body.subarray(body.length - TAG_BYTES)

    // Every key is tried, so rotating `APP_KEY` does not invalidate what is
    // already stored. The tag is what decides; a wrong key simply fails to
    // authenticate.
    for (const key of this.keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        if (context !== undefined) decipher.setAAD(new TextEncoder().encode(context))
        decipher.setAuthTag(tag)

        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      } catch {
        // Try the next key. The reason is deliberately not reported.
      }
    }

    throw new DecryptError()
  }

  /**
   * Does this look like one of our payloads?
   *
   * A shape test only — it proves nothing about authenticity, and is here so a
   * migration can tell an already-encrypted column from a plaintext one.
   */
  static appearsEncrypted(value: unknown): value is string {
    if (typeof value !== 'string') return false

    const parts = value.split('.')

    return parts.length === 3 && parts[0] === VERSION && parts[1]?.length === 16
  }

  /** How many keys this encrypter will read with. For diagnostics. */
  get keyCount(): number {
    return this.keys.length
  }
}

/** base64url, without padding: safe in a cookie, a URL and a header. */
function base64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}
