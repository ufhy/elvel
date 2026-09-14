import { ServiceProvider } from '@elvel/core'
import { RedisManager } from './manager.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    redis: RedisManager
  }
}

/**
 * Binds the Redis manager.
 *
 * Registered rather than booted, because the cache, the queue and the
 * broadcaster all resolve their connection while *they* register — and a
 * manager that appeared later would have them each build a client of their own
 * first, which is the thing this exists to stop.
 */
export class RedisServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('redis', (app) => new RedisManager(app))
  }

  override boot(): void {
    // Closed on shutdown: an open client holds the event loop, so a command that
    // finished in milliseconds would keep the process alive.
    const app = this.app as { terminating?: (callback: () => void) => unknown }

    app.terminating?.(() => {
      if (this.app.bound('redis')) this.app.make('redis').disconnect()
    })
  }
}
