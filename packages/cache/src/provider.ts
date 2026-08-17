import { ServiceProvider } from '@elyvel/core'
import { CacheClearCommand } from './console/cache-clear.ts'
import { CacheForgetCommand } from './console/cache-forget.ts'
import { CachePruneCommand } from './console/cache-prune.ts'
import { CacheTableCommand } from './console/cache-table.ts'
import { CacheManager } from './manager.ts'
import { RateLimiter } from './rate-limiter.ts'

declare module '@elyvel/contracts' {
  interface ContainerBindings {
    cache: CacheManager
    'cache.limiter': RateLimiter
  }
}

/**
 * Binds the cache manager and the rate limiter.
 *
 * Both are singletons: a store memoises its connection and, for the array driver,
 * the data itself, so resolving a second manager would quietly give a second
 * cache. Nothing is opened here — a store connects on its first use, which keeps
 * an application that never touches Redis from requiring one.
 */
export class CacheServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('cache', (app) => new CacheManager(app))

    this.app.singleton('cache.limiter', (app) => {
      const store = this.config<string | undefined>('cache.limiter', undefined)

      return new RateLimiter(app.make('cache').store(store))
    })
  }

  override boot(): void {
    if (this.app.bound('artisan')) {
      this.app
        .make('artisan')
        .register(CacheClearCommand, CacheForgetCommand, CachePruneCommand, CacheTableCommand)
    }
  }
}
