import { env } from '@elvel/core'

export default {
  /**
   * The master switch. Off unless asked for.
   *
   * Laravel Telescope defaults this on and relies on the published provider's
   * filter to keep production quiet. That inverts badly here: an application
   * that installs the package and forgets the provider would record everything.
   * So the default is off and turning it on is a deliberate act.
   */
  enabled: env('LENS_ENABLED', false),

  /** Where the dashboard is served from. */
  path: env('LENS_PATH', 'lens'),

  /** Only `database` today. An unknown driver binds nothing and says so. */
  driver: env('LENS_DRIVER', 'database'),

  storage: {
    database: {
      connection: env('LENS_DB_CONNECTION', undefined),
      /** Rows per insert and per delete pass. */
      chunk: 1000
    }
  },

  /**
   * Paths the recorder ignores, matched against the request path.
   *
   * The dashboard's own API is in here because a recorder that watches itself
   * grows without bound — the first thing that went wrong in the spike this
   * package came from.
   */
  ignorePaths: ['lens-api*', '.well-known*'],

  /** Commands never recorded. A worker loop would record itself forever. */
  ignoreCommands: ['queue:work', 'queue:listen', 'schedule:work', 'lens:prune', 'lens:clear'],

  /**
   * Watchers, as a map of name to `false` or its options.
   *
   * `false` and `{ enabled: false }` both mean "do not register" — nothing is
   * constructed, so a disabled watcher costs nothing rather than costing a
   * listener that returns early.
   */
  watchers: {
    request: {
      enabled: env('LENS_REQUEST_WATCHER', true),
      /**
       * Kilobytes of response body kept before the whole thing is replaced.
       *
       * Telescope's number and Telescope's arithmetic — whole kilobytes, at or
       * under the limit. Above it the body is not truncated but dropped, because
       * half a JSON document is not worth storing.
       */
      sizeLimit: Number(env('LENS_RESPONSE_SIZE_LIMIT', 64)),
      ignoreHttpMethods: [] as string[],
      ignoreStatusCodes: [] as number[],
      /** Response keys masked on the way in, beside the request's `password`. */
      hiddenResponseParameters: [] as string[]
    },

    batch: {
      enabled: env('LENS_BATCH_WATCHER', true)
    },

    cache: {
      enabled: env('LENS_CACHE_WATCHER', true),
      /**
       * Keys whose value is masked, and keys dropped outright.
       *
       * Both take a name or a `prefix*` glob. Worth setting: a cache entry's
       * **value is recorded**, which Telescope also does, so whatever the
       * application caches ends up in a table.
       */
      hidden: [] as string[],
      ignore: [] as string[]
    },

    /** Every outgoing call made through `@elvel/http-client`. */
    client_request: {
      enabled: env('LENS_CLIENT_REQUEST_WATCHER', true),
      /** Hosts never recorded — a metrics sink, a health check. */
      ignoreHosts: [] as string[]
    },

    command: {
      enabled: env('LENS_COMMAND_WATCHER', true),
      /**
       * Commands never recorded.
       *
       * A long-running command never finishes, so its batch never flushes and
       * everything it saw is lost anyway — recording the attempt only fills the
       * list with rows that say nothing.
       */
      ignore: ['queue:work', 'queue:listen', 'schedule:work', 'serve', 'dev', 'lens:*']
    },

    /**
     * Off by default, like the event watcher.
     *
     * A dump is written to be read now, in the terminal — Telescope goes
     * further and only registers its watcher while the Dumps screen is open.
     * Turn this on when you want the trail kept.
     */
    dump: {
      enabled: env('LENS_DUMP_WATCHER', false)
    },

    /**
     * Off by default, like the dump watcher and for a related reason.
     *
     * A wildcard listener sees every event the application dispatches, which is
     * the most useful screen in the dashboard for some applications and pure
     * noise in others. Turn it on deliberately.
     */
    event: {
      enabled: env('LENS_EVENT_WATCHER', false),
      /** Framework events are covered by their own watchers. */
      ignoreFrameworkEvents: true,
      ignore: [] as string[]
    },

    exception: {
      enabled: env('LENS_EXCEPTION_WATCHER', true),
      /** Frames from these paths never answer "where did this fail". */
      ignorePaths: [] as string[]
    },

    job: {
      enabled: env('LENS_JOB_WATCHER', true),
      /** Job class names never recorded. */
      ignore: [] as string[]
    },

    log: {
      enabled: env('LENS_LOG_WATCHER', true),
      /**
       * The floor, as Telescope sets it.
       *
       * `debug` in a chatty application out-grows every other entry type
       * combined, which is why this is not the default even though it is the
       * default log level.
       */
      level: env('LENS_LOG_LEVEL', 'error')
    },

    gate: {
      enabled: env('LENS_GATE_WATCHER', true),
      ignoreAbilities: [] as string[],
      ignorePaths: [] as string[]
    },

    mail: {
      enabled: env('LENS_MAIL_WATCHER', true),
      /** Kilobytes of body kept. The body is recorded so it can be previewed. */
      bodyLimit: Number(env('LENS_MAIL_BODY_LIMIT', 128))
    },

    model: {
      enabled: env('LENS_MODEL_WATCHER', true),
      /** Model class names never recorded. */
      ignore: [] as string[]
    },

    notification: {
      enabled: env('LENS_NOTIFICATION_WATCHER', true)
    },

    schedule: {
      enabled: env('LENS_SCHEDULE_WATCHER', true)
    },

    view: {
      enabled: env('LENS_VIEW_WATCHER', true),
      /** Component names never recorded. */
      ignore: [] as string[]
    },

    query: {
      enabled: env('LENS_QUERY_WATCHER', true),
      /** Milliseconds at or above which a query is tagged `slow`. */
      slow: 100,
      /** Drop frames from these paths when locating the caller. */
      ignorePaths: [] as string[]
    }
  }
}
