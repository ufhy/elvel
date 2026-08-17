import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
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

/** A payload split into its parts, before any key has been tried against it. */
type Parsed = { iv: Buffer; ciphertext: Buffer; tag: Buffer }

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

  /** Its own key, derived for one purpose — see `blindIndex`. */
  private readonly indexKey: Buffer

  constructor(secret: string, options: EncrypterOptions = {}) {
    const purpose = options.purpose ?? 'elyvel:encrypt:v1'

    // The primary key is first: it is what writes, and what reads are tried
    // against first.
    this.keys = [secret, ...(options.previousKeys ?? [])].map((key) => deriveKey(key, purpose))
    this.indexKey = deriveKey(secret, `${purpose}:blind-index`)
  }

  /**
   * A deterministic fingerprint of a value, for searching an encrypted column.
   *
   * Encryption is not searchable, and that is not a limitation to work around —
   * it is the point. `where('email', ...)` against a ciphertext column can never
   * match, because every write produces different bytes. A blind index is the
   * standard answer: store an HMAC of the plaintext beside the ciphertext and
   * search *that*.
   *
   * What it costs is honest to state. The index is **deterministic**, so equal
   * plaintexts produce equal fingerprints, and anyone who can read the column can
   * tell which rows hold the same value — and, for a small domain like a status
   * or a country, can confirm a guess by computing the fingerprint of it. Never
   * index a low-entropy column. It also supports equality only: no ordering, no
   * prefix search, no `like`.
   *
   * Keyed with its own derived key, so a leaked index tells you nothing about the
   * ciphertext beside it, and bound to a context — usually the column — so the
   * same email address in two tables does not produce the same fingerprint.
   */
  blindIndex(value: string, context = ''): string {
    return createHmac('sha256', this.indexKey)
      .update(`${context}\u0000${value}`)
      .digest('base64url')
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

  /**
   * Is this payload readable by the **current** key alone?
   *
   * The question `encryption:rotate` needs and could not ask. A payload written
   * under a previous key has to be re-encrypted; one already on the current key
   * does not, and re-writing it costs a decrypt, an encrypt and an UPDATE for no
   * change. On a table that has been rotated once already that is the difference
   * between a minute and an hour.
   *
   * Laravel answers this by handing out `getKey()` and `getAllKeys()` and
   * leaving the comparison to the caller. This does not: key material on a
   * service that every part of an application can reach is one stray log line
   * away from being published, and an application that needs its own key can
   * derive a purpose-bound one from `APP_KEY` with `deriveKey`, which is safer
   * than sharing this one.
   *
   * `false` for anything that does not decrypt at all — an unreadable payload is
   * not "already current".
   */
  usesCurrentKey(payload: string, context?: string): boolean {
    const parsed = Encrypter.parse(payload)

    if (!parsed) return false

    const [current] = this.keys

    return current !== undefined && this.open(current, parsed, context) !== undefined
  }

  /** Decrypt a string written by `encryptString`. */
  decryptString(payload: string, context?: string): string {
    const parsed = Encrypter.parse(payload)

    if (!parsed) throw new DecryptError()

    // Every key is tried, so rotating `APP_KEY` does not invalidate what is
    // already stored. The tag is what decides; a wrong key simply fails to
    // authenticate.
    for (const key of this.keys) {
      const opened = this.open(key, parsed, context)

      if (opened !== undefined) return opened
    }

    throw new DecryptError()
  }

  /** Split a payload into its parts, or nothing when it is not one of ours. */
  private static parse(payload: string): Parsed | undefined {
    if (typeof payload !== 'string') return undefined

    const parts = payload.split('.')

    if (parts.length !== 3 || parts[0] !== VERSION) return undefined

    const iv = fromBase64url(parts[1] as string)
    const body = fromBase64url(parts[2] as string)

    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) return undefined

    return {
      iv,
      ciphertext: body.subarray(0, body.length - TAG_BYTES),
      tag: body.subarray(body.length - TAG_BYTES)
    }
  }

  /** One key, one attempt. `undefined` means the tag did not authenticate. */
  private open(key: Buffer, parsed: Parsed, context?: string): string | undefined {
    const { iv, ciphertext, tag } = parsed

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      if (context !== undefined) decipher.setAAD(new TextEncoder().encode(context))
      decipher.setAuthTag(tag)

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      // This key is not the one. The reason is deliberately not reported: which
      // step failed is information about the key, and the caller gets a single
      // opaque failure either way.
      return undefined
    }
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
