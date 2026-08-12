import { app } from '@elysian/core'
import type { Encrypter } from './encrypter.ts'

/** The application encrypter. */
export function encrypter(): Encrypter {
  return app('encrypter')
}

/**
 * Encrypt a value.
 *
 * ```ts
 * const payload = encrypt({ userId: 7 })
 * const { userId } = decrypt<{ userId: number }>(payload)
 * ```
 *
 * `context` is bound into the authentication tag: a payload encrypted for one
 * context cannot be decrypted as another.
 */
export function encrypt(value: unknown, context?: string): string {
  return encrypter().encrypt(value, context)
}

export function decrypt<T = unknown>(payload: string, context?: string): T {
  return encrypter().decrypt<T>(payload, context)
}

export function encryptString(value: string, context?: string): string {
  return encrypter().encryptString(value, context)
}

export function decryptString(payload: string, context?: string): string {
  return encrypter().decryptString(payload, context)
}
