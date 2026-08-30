import { env } from '@elvel/core'

export default {
  /** Which store `cache()` uses when none is named. */
  default: env('CACHE_STORE', 'file'),

  /**
   * Prefix on every key, so two applications can share one Redis or one cache
   * table without colliding. Changing it is a cache flush by another name.
   */
  prefix: env('CACHE_PREFIX', 'elvel_cache_'),

  /**
   * Seconds a value may be served from this process's memory. `0` is off.
   *
   * A `get()` against the file store costs about 26µs, and 96% of that is the
   * filesystem read — measured, not guessed. Hashing is 2% and decoding is half a
   * percent, so there is nothing to shave: the only way to make a hot key cheap is
   * not to go to the store. With a one-second window a repeated read costs 0.09µs
   * instead of 25µs.
   *
   * **It trades freshness, and the number you pick is how stale a value may be.**
   * Writes made here drop the entry at once, so a single-process application never
   * serves its own stale value. A second process — another worker, a queue, a
   * command — can write a key this one keeps for up to this many seconds.
   *
   * Right for configuration, feature flags and permission maps. Wrong for
   * counters and rate limits, which are read-modify-write; set `memory: 0` on
   * those stores. Off by default because the trade should be chosen, not
   * inherited.
   */
  memory: Number(env('CACHE_MEMORY', 0)),

  /** Store the rate limiter counts in. Undefined means the default store. */
  limiter: env('CACHE_LIMITER', 'array'),

  stores: {
    /** Per-process memory. Fast, and gone when the process is. */
    array: { driver: 'array' },

    /** The default: no service to run, and it survives a restart. */
    file: { driver: 'file' },

    /** Run `elvel cache:table` and `elvel migrate` before selecting this. */
    database: { driver: 'database', table: 'cache', lockTable: 'cache_locks' },

    redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379') }
  }
}
