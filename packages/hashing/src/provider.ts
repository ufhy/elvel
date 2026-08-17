import { ServiceProvider } from '@elyvel/core'
import { HashManager } from './manager.ts'

declare module '@elyvel/contracts' {
  interface ContainerBindings {
    hash: HashManager
  }
}

/** Binds the hash manager. A singleton, so drivers are built once. */
export class HashServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('hash', (app) => new HashManager(app))
  }
}
