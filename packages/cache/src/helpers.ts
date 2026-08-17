import { app } from '@elyvel/core'
import type { CacheManager } from './manager.ts'
import type { RateLimiter } from './rate-limiter.ts'
import type { Repository } from './repository.ts'

/** The default cache store, or a named one. */
export function cache(store?: string): Repository {
  return app('cache').store(store)
}

/** The manager itself, for `extend()` and store bookkeeping. */
export function cacheManager(): CacheManager {
  return app('cache')
}

/** The shared rate limiter, on whichever store `cache.limiter` names. */
export function limiter(): RateLimiter {
  return app('cache.limiter')
}
