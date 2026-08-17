import { env } from '@elvel/core'

export default {
  /** Which store `cache()` uses when none is named. */
  default: env('CACHE_STORE', 'file'),

  /**
   * Prefix on every key, so two applications can share one Redis or one cache
   * table without colliding. Changing it is a cache flush by another name.
   */
  prefix: env('CACHE_PREFIX', 'playground_cache_'),

  /** Store the rate limiter counts in. Undefined means the default store. */
  limiter: env('CACHE_LIMITER', 'array'),

  stores: {
    /** Per-process memory. Fast, and gone when the process is. */
    array: { driver: 'array' },

    /** The default: no service to run, and it survives a restart. */
    file: { driver: 'file' },

    /** Needs `artisan cache:table` and a migration. */
    database: { driver: 'database', table: 'cache', lockTable: 'cache_locks' },

    redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379') }
  }
}
