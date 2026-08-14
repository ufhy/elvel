import { app } from '@elysian/core'
import type { HashManager } from './manager.ts'

/**
 * The hash manager — Laravel's `Hash` facade.
 *
 * ```ts
 * const token = await hash().make(secret)
 * if (await hash().check(secret, token)) { … }
 * ```
 */
export function hash(): HashManager {
  return app('hash')
}
