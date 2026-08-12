import { hkdfSync, randomBytes } from 'node:crypto'

/** How many bytes AES-256 needs. */
export const KEY_BYTES = 32

/** The shortest secret we will derive from. */
const MINIMUM_SECRET_BYTES = 32

/**
 * The raw bytes of a configured key.
 *
 * `base64:` is honoured because that is what `key:generate` writes and what
 * anyone coming from Laravel will paste; anything else is taken as its own bytes.
 */
export function secretBytes(secret: string): Uint8Array {
  if (secret.startsWith('base64:')) {
    const decoded = Buffer.from(secret.slice('base64:'.length), 'base64')

    if (decoded.length === 0) {
      throw new Error('APP_KEY looks like base64 but decodes to nothing.')
    }

    return new Uint8Array(decoded)
  }

  return new TextEncoder().encode(secret)
}

/**
 * A key for one purpose, derived from the application secret.
 *
 * HKDF rather than the secret itself, and this is the part worth understanding:
 * `APP_KEY` already signs cookies. Handing the same bytes to AES as well would mean
 * one compromise leaks both, and it would let a value produced for one purpose be
 * accepted by another. A distinct `info` label per purpose gives each an
 * independent key from the same configured secret, and it also frees the secret
 * from having to be exactly 32 bytes.
 */
export function deriveKey(secret: string, purpose: string): Buffer {
  const bytes = secretBytes(secret)

  if (bytes.length < MINIMUM_SECRET_BYTES) {
    throw new Error(
      `APP_KEY is too short (${bytes.length} bytes). Use at least ${MINIMUM_SECRET_BYTES}, or run: artisan key:generate`
    )
  }

  return Buffer.from(
    hkdfSync(
      'sha256',
      bytes,
      // No salt: the secret is already high-entropy, and a per-application salt
      // would have to be stored somewhere as well — which is one more thing to
      // lose. The `info` label is what separates the purposes.
      new Uint8Array(0),
      new TextEncoder().encode(purpose),
      KEY_BYTES
    )
  )
}

/** A fresh application key, in the form configuration expects. */
export function generateKey(): string {
  return `base64:${randomBytes(KEY_BYTES).toString('base64')}`
}
