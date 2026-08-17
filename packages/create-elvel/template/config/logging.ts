import { env } from '@elvel/core'

export default {
  /** Channel used by `log().info(...)`. */
  default: env('LOG_CHANNEL', 'stack'),

  /**
   * Each channel pairs a driver with a minimum level. Levels, in descending
   * severity: emergency, alert, critical, error, warning, notice, info, debug.
   */
  channels: {
    stack: {
      driver: 'stack',
      channels: ['console']
    },

    /** Human-readable, coloured. Best for development. */
    console: {
      driver: 'console',
      level: env('LOG_LEVEL', 'debug')
    },

    /** One JSON object per line, for log collectors. Best for production. */
    json: {
      driver: 'json',
      stream: 'stdout',
      level: env('LOG_LEVEL', 'info')
    },

    single: {
      driver: 'single',
      level: env('LOG_LEVEL', 'debug')
    },

    daily: {
      driver: 'daily',
      level: env('LOG_LEVEL', 'debug'),
      maxFiles: 14
    },

    null: {
      driver: 'null'
    }
  },

  /** Access log. Off by default so it never surprises you in tests. */
  requests: {
    enabled: env('LOG_REQUESTS', false),
    channel: undefined,
    header: 'x-request-id'
  }
}
