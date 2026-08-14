import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DecryptError, EncryptError } from './encrypter.ts'

const VERSION = 'e1'
const IV_BYTES = 12
const KEY_BYTES = 32

/**
 * Something that guards a master key — a KMS, an HSM, or a file on a machine
 * this process cannot read.
 *
 * The only two operations that matter: wrap a data key, and unwrap it again. The
 * master key itself never leaves whatever holds it, which is the entire point of
 * using one.
 */
export interface MasterKeyProvider {
  /** Encrypt a data key. The blob is stored beside the payload. */
  wrap(dataKey: Uint8Array, context?: string): Promise<string>

  /** Recover a data key. Throws when the blob was not wrapped by this key. */
  unwrap(wrapped: string, context?: string): Promise<Uint8Array>
}

/**
 * Envelope encryption — a fresh key per payload, wrapped by a master key.
 *
 * `Encrypter` derives one key from `APP_KEY` and uses it for everything. That is
 * right for a cookie and wrong for a compliance boundary: the key lives in the
 * application's environment, so anything that can read the environment can read
 * every payload ever written, and rotating it means re-encrypting all of them.
 *
 * Here each payload gets its own random data key, encrypted with it, and the
 * data key is wrapped by a master key held somewhere this process cannot read.
 * What that buys, concretely:
 *
 * - **The master key never reaches this process.** A memory dump yields one
 *   payload's data key, not the ability to read the table.
 * - **Rotation is re-wrapping**, not re-encrypting: the data keys are unchanged,
 *   so only the small wrapped blobs need rewriting.
 * - **Revocation is real.** Disable the master key and every payload becomes
 *   unreadable at once, including copies in backups.
 *
 * The cost is a network call per decrypt, which is why this is **asynchronous**
 * and cannot back a model cast — those run inside synchronous attribute access.
 * Use it where the value is read rarely and matters a great deal.
 */
export class EnvelopeEncrypter {
  constructor(private readonly master: MasterKeyProvider) {}

  /**
   * Encrypt a value under a data key of its own.
   *
   * The payload is `e1.<wrapped key>.<iv>.<ciphertext‖tag>` — the wrapped key
   * travels with the ciphertext because nothing else knows which key opened it,
   * and a payload that cannot say is a payload that becomes unreadable the first
   * time a key is rotated.
   */
  async encrypt(value: unknown, context?: string): Promise<string> {
    const serialised = JSON.stringify(value)

    if (serialised === undefined) {
      throw new EncryptError('Only JSON-serialisable values can be encrypted.')
    }

    return this.encryptString(serialised, context)
  }

  async encryptString(value: string, context?: string): Promise<string> {
    const dataKey = randomBytes(KEY_BYTES)
    const iv = randomBytes(IV_BYTES)

    const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
    if (context !== undefined) cipher.setAAD(new TextEncoder().encode(context))

    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const wrapped = await this.master.wrap(dataKey, context)

    return [
      VERSION,
      base64url(Buffer.from(wrapped)),
      base64url(iv),
      base64url(Buffer.concat([ciphertext, cipher.getAuthTag()]))
    ].join('.')
  }

  async decrypt<T = unknown>(payload: string, context?: string): Promise<T> {
    const plain = await this.decryptString(payload, context)

    try {
      return JSON.parse(plain) as T
    } catch {
      throw new DecryptError('Decrypted the payload, but it does not contain JSON.')
    }
  }

  async decryptString(payload: string, context?: string): Promise<string> {
    const [version, wrapped, iv, body] = payload.split('.')

    if (version !== VERSION || !wrapped || !iv || !body) {
      throw new DecryptError('The payload is not in the envelope format.')
    }

    const dataKey = await this.master.unwrap(Buffer.from(wrapped, 'base64url').toString(), context)

    const bytes = Buffer.from(body, 'base64url')
    const tag = bytes.subarray(bytes.length - 16)
    const ciphertext = bytes.subarray(0, bytes.length - 16)

    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(iv, 'base64url'))
    if (context !== undefined) decipher.setAAD(new TextEncoder().encode(context))
    decipher.setAuthTag(tag)

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      // The tag failing means the ciphertext, the context or the data key is
      // wrong — indistinguishable on purpose, since saying which would help
      // somebody probing.
      throw new DecryptError('Could not decrypt the payload.')
    }
  }

  /**
   * Re-wrap a payload's data key under the master key's current version.
   *
   * The rotation an envelope makes cheap: the ciphertext is untouched, so a
   * table of ten million rows is ten million small updates rather than ten
   * million decrypt-and-re-encrypt round trips.
   */
  async rewrap(payload: string, context?: string): Promise<string> {
    const [version, wrapped, iv, body] = payload.split('.')

    if (version !== VERSION || !wrapped || !iv || !body) {
      throw new DecryptError('The payload is not in the envelope format.')
    }

    const dataKey = await this.master.unwrap(Buffer.from(wrapped, 'base64url').toString(), context)

    return [
      VERSION,
      base64url(Buffer.from(await this.master.wrap(dataKey, context))),
      iv,
      body
    ].join('.')
  }
}

/**
 * A provider backed by a local key — for tests, and for a single machine.
 *
 * Honest about what it is: the key is in this process, so it gives none of the
 * guarantees a real KMS does. It exists so the envelope format can be exercised
 * without standing up a KMS, and so an application can adopt the shape now and
 * change the provider later without touching the stored payloads' format.
 */
export class LocalMasterKey implements MasterKeyProvider {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`A master key must be ${KEY_BYTES} bytes.`)
    }
  }

  async wrap(dataKey: Uint8Array, context?: string): Promise<string> {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)

    if (context !== undefined) cipher.setAAD(new TextEncoder().encode(context))

    const sealed = Buffer.concat([cipher.update(dataKey), cipher.final(), cipher.getAuthTag()])

    return `${base64url(iv)}.${base64url(sealed)}`
  }

  async unwrap(wrapped: string, context?: string): Promise<Uint8Array> {
    const [iv, sealed] = wrapped.split('.')

    if (!iv || !sealed) throw new DecryptError('The wrapped key is malformed.')

    const bytes = Buffer.from(sealed, 'base64url')
    const tag = bytes.subarray(bytes.length - 16)

    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    if (context !== undefined) decipher.setAAD(new TextEncoder().encode(context))
    decipher.setAuthTag(tag)

    try {
      return Buffer.concat([
        decipher.update(bytes.subarray(0, bytes.length - 16)),
        decipher.final()
      ])
    } catch {
      throw new DecryptError('Could not unwrap the data key.')
    }
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}
