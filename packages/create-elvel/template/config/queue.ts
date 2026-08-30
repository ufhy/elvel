import { env } from '@elvel/core'

export default {
  /**
   * Connection `dispatch()` uses when a job does not name one.
   *
   * `sync` runs the job inside `dispatch()` — no worker to run and a failure
   * throws where you can see it. Move to `database` or `redis` when you want the
   * request to return before the work is done.
   */
  default: env('QUEUE_CONNECTION', 'sync'),

  connections: {
    sync: { driver: 'sync' },

    /** Run `elvel queue:table` and `elvel migrate` before selecting this. */
    database: {
      driver: 'database',
      table: 'jobs',
      queue: 'default',
      /**
       * Seconds a reservation is trusted. Set this above your slowest job: a job
       * still running when it expires will be picked up a second time.
       */
      retryAfter: 90
    },

    redis: {
      driver: 'redis',
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
      queue: 'default',
      retryAfter: 90,
      /**
       * Seconds between sweeps for due delayed jobs and expired reservations.
       *
       * The sweep runs on `pop`, which on a busy queue happens as fast as jobs are
       * taken — two extra round trips per job to ask whether anything became due in
       * the meantime. Both sets are scored in whole seconds, so once a second finds
       * everything a busier sweep would.
       *
       * The cost is patience: a delayed job may start up to this many seconds after
       * its time, and a job abandoned by a dead worker is recovered that much later.
       * `0` sweeps on every pop, which is what Laravel does.
       */
      migrateEvery: 1
    }
  },

  /**
   * Where failures are recorded, so `queue:retry` has something to work from.
   *
   * `null` discards them; `database` needs `elvel queue:failed-table`.
   */
  failed: {
    driver: env('QUEUE_FAILED_DRIVER', 'null'),
    table: 'failed_jobs'
  }
}
