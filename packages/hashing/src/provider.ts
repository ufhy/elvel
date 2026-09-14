import { ServiceProvider } from '@elvel/core'
import { HashManager } from './manager.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    hash: HashManager
  }
}

/** Binds the hash manager. A singleton, so drivers are built once. */
export class HashServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('hash', (app) => new HashManager(app))
  }

  /**
   * Let the `hashed` attribute cast reach the configured hasher.
   *
   * `makeSync` rather than `make`, because a cast is synchronous — and forwarded
   * per call rather than captured, so the driver named in `config/hashing.ts`
   * is the one that runs even if it is swapped later.
   *
   * Same shape as the encryption provider's: the database package must keep
   * working with no hashing package present, and one cast needs one.
   */
  override async boot(): Promise<void> {
    if (!this.app.bound('db')) return

    const { setAttributeHasher } = await import('@elvel/database')
    const resolve = () => this.app.make('hash')

    setAttributeHasher({
      makeSync: (value) => resolve().makeSync(value),
      isHashed: (value) => resolve().isHashed(value)
    })
  }
}
