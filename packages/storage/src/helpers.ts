import { app } from '@elvel/core'
import type { Disk } from './contracts.ts'
import type { StorageManager } from './manager.ts'

/** The storage manager. */
export function storage(): StorageManager {
  return app('storage')
}

/**
 * A disk, or the default one.
 *
 * ```ts
 * await disk('public').put('avatars/1.png', bytes)
 * disk('s3').temporaryUrl('invoices/7.pdf', 300)
 * ```
 */
export function disk(name?: string): Disk {
  return storage().disk(name)
}
