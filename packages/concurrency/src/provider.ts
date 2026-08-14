import { ServiceProvider } from '@elysian/core'
import { ConcurrencyManager } from './manager.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    concurrency: ConcurrencyManager
  }
}

/** Binds the concurrency manager. A singleton, so drivers are built once. */
export class ConcurrencyServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('concurrency', (app) => new ConcurrencyManager(app))
  }
}
