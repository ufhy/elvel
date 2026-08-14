import { ServiceProvider } from '@elysian/core'
import { ProcessManager } from './factory.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    process: ProcessManager
  }
}

/**
 * Binds the process manager.
 *
 * A singleton, because the fake's recording lives on it: two instances would
 * mean `assertRan()` looking at a different tape from the one the code wrote to.
 */
export class ProcessServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('process', () => new ProcessManager())
  }
}
