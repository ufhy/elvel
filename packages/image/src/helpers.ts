import { app } from '@elvel/core'
import type { ImageManager } from './manager.ts'

/**
 * The image manager.
 *
 * ```ts
 * const thumbnail = await image().fromBytes(upload).cover(200, 200).toWebp(80).toBytes()
 * ```
 */
export function image(): ImageManager {
  return app('image')
}
