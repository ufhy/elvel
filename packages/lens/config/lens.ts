import { env } from '@elvel/core'

export default {
  /**
   * The master switch. Off unless asked for.
   *
   * Telescope defaults this on and relies on the published provider's
   * filter to keep production quiet. That inverts badly here: an application
   * that installs the package and forgets the provider would record everything.
   * So the default is off and turning it on is a deliberate act.
   */
  enabled: env('LENS_ENABLED', false),

  /** Where the dashboard is served from. */
  path: env('LENS_PATH', 'lens'),

  /**
   * The inspection bar, drawn into HTML pages the application returns.
   *
   * `null` means "follow `APP_DEBUG`", which is the rule a debug bar wants and the
   * right one: a bar showing query results belongs to the same switch as a
   * stack trace in the browser. Setting it explicitly wins — but forcing it on
   * while debug is off makes every injection pass `authorise()` first, which is
   * the lock Debugbar does not have and the reason its leaks happen.
   *
   * Unlike the dashboard, the bar needs no tables: it reads a ring of the last
   * few requests held in memory. `LENS_BAR=true` on its own is a complete
   * installation.
   */
  bar: {
    enabled: env('LENS_BAR', null),

    /** How many recent requests the bar can switch between. */
    requests: Number(env('LENS_BAR_REQUESTS', 20)),

    /**
     * Bytes the ring may hold, whichever limit is reached first.
     *
     * A count is not a bound when one batch can carry a 64 KB response body and
     * a page renders a hundred components — and `bun elvel dev` runs for days.
     */
    budget: Number(env('LENS_BAR_BUDGET', 8 * 1024 * 1024)),

    /**
     * A URL for opening a file, with `{file}` and `{line}` replaced.
     *
     * Empty by default rather than guessing `vscode://file/{file}:{line}`,
     * because a link that does nothing is worse than the path written out. Set
     * it to your editor's scheme and every query, exception and dump on the bar
     * becomes one click from the line that caused it.
     */
    editor: env('LENS_BAR_EDITOR', ''),

    /**
     * The numbers the bar's analysis argues from.
     *
     * Every finding is a judgement about what is worth interrupting for, and
     * every judgement here is arguable: a hundred milliseconds is a slow query
     * in a request and an ordinary one in a nightly report. Name the one you
     * disagree with; the rest keep their defaults.
     *
     * ```ts
     * thresholds: { slowQuery: 250, logLines: 50 }
     * ```
     *
     * `slowQuery`, `repeats`, `responseBytes`, `viewMs`, `databaseShare`,
     * `logLines`, `events`, `viewBytes`, `callBytes`, `cacheBytes`,
     * `cacheSeconds`, `slowerThanUsual`, `middlewareShare`, `frameworkShare`,
     * `payloadBytes`, `attachments`, `cacheLookups`, `missShare`.
     */
    thresholds: {} as Record<string, number>
  },

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
      ignore: [] as string[],
      /**
       * Attribute names whose value is masked, the key still recorded.
       *
       * An `encrypted` or `hashed` cast is masked already, and so is anything in
       * the model's own `hidden` — this is for the column that is neither and is
       * still nobody's business.
       */
      hidden: [] as string[]
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
    },

    /**
     * Redis commands, from the connections `@elvel/redis` manages.
     *
     * Off unless that package is installed: without it the events never fire and
     * a watcher listening for them records nothing.
     */
    redis: {
      enabled: env('LENS_REDIS_WATCHER', false),
      /** Commands never recorded — a worker's poll, most usefully. */
      ignore: [] as string[]
    }
  }
}
