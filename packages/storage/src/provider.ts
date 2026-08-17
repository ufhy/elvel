import { ServiceProvider } from '@elvel/core'
import { StorageLinkCommand } from './console/storage-link.ts'
import { StorageUnlinkCommand } from './console/storage-unlink.ts'
import { StorageManager } from './manager.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    storage: StorageManager
  }
}

/**
 * Binds the storage manager.
 *
 * Nothing is opened here: a disk is built on first use, so an application that
 * never touches S3 never constructs a client for it.
 */
export class StorageServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('storage', (app) => new StorageManager(app))
  }

  override boot(): void {
    if (this.app.bound('artisan')) {
      this.app.make('artisan').register(StorageLinkCommand, StorageUnlinkCommand)
    }
  }
}
