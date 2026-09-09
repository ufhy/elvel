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

    exception: {
      enabled: env('LENS_EXCEPTION_WATCHER', true),
      /** Frames from these paths never answer "where did this fail". */
      ignorePaths: [] as string[]
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

    query: {
      enabled: env('LENS_QUERY_WATCHER', true),
      /** Milliseconds at or above which a query is tagged `slow`. */
      slow: 100,
      /** Drop frames from these paths when locating the caller. */
      ignorePaths: [] as string[]
    }
  }
}
