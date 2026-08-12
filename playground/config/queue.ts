import { env } from '@elysian/core'

export default {
  /** Connection `dispatch()` uses when a job does not name one. */
  default: env('QUEUE_CONNECTION', 'database'),

  connections: {
    /**
     * No queue: the job runs inside `dispatch()`.
     *
     * The right default while writing a job — a failure throws where you can see
     * it, and a test does not have to run a worker.
     */
    sync: { driver: 'sync' },

    /** Needs `artisan queue:table` and a migration. */
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

  /** Where failures are recorded, so `queue:retry` has something to work from. */
  failed: {
    driver: env('QUEUE_FAILED_DRIVER', 'database'),
    table: 'failed_jobs'
  }
}
