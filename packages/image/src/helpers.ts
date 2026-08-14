import { app } from '@elysian/core'
import type { ImageManager } from './manager.ts'

/**
 * The image manager — Laravel's `Image` facade.
 *
 * ```ts
 * const thumbnail = await image().fromBytes(upload).cover(200, 200).toWebp(80).toBytes()
 * ```
 */
export function image(): ImageManager {
  return app('image')
}
