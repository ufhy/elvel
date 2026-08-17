import { env } from '@elyvel/core'

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

    /** Run `artisan queue:table` and `artisan migrate` before selecting this. */
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
      retryAfter: 90
    }
  },

  /**
   * Where failures are recorded, so `queue:retry` has something to work from.
   *
   * `null` discards them; `database` needs `artisan queue:failed-table`.
   */
  failed: {
    driver: env('QUEUE_FAILED_DRIVER', 'null'),
    table: 'failed_jobs'
  }
}
