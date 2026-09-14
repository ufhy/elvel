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

    /**
     * Discard everything.
     *
     * For an environment that must not run background work — a read-only
     * replica, a CI boot check, a maintenance process. `sync` is the wrong
     * answer there, because it runs the job.
     */
    null: { driver: 'null' },

    /**
     * Try the next connection when one is unreachable.
     *
     * A Redis that stops answering turns every `dispatch()` into an exception,
     * and the dispatch usually happens after the work that mattered is already
     * done. Only pushes fail over: a worker polling a dead connection should say
     * so, not quietly drain a different queue.
     */
    failover: {
      driver: 'failover',
      connections: ['redis', 'database']
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
       * `0` sweeps on every pop.
       */
      migrateEvery: 1,
      /**
       * Seconds an idle worker waits to be woken, instead of polling.
       *
       * Unset, a worker with nothing to do sleeps `--sleep` seconds between looks,
       * so a job pushed just after a look waits that long to start — 1.7 seconds on
       * average with the default of three. Set, the worker holds a blocking read
       * and starts the job in about two milliseconds.
       *
       * The cost is a second Redis connection per worker, held open for as long as
       * it waits. Unset by default for that reason.
       */
      blockFor: undefined as number | undefined
    }
  },

  /**
   * Where failures are recorded, so `queue:retry` has something to work from.
   *
   * `array` keeps them for the life of the process, `file` writes a line per
   * failure — for a worker with no database — `database` needs
   * `elvel queue:failed-table`, and `null` genuinely discards them.
   *
   * The default is `array` and used to be written `null` while behaving as
   * `array`, which meant the config promised something it did not do.
   */
  failed: {
    driver: env('QUEUE_FAILED_DRIVER', 'array'),
    table: 'failed_jobs',
    /** Where the `file` driver writes. Defaults to storage/framework. */
    path: undefined as string | undefined
  }
}
