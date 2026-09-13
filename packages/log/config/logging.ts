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

    /**
     * Rotation by size as well as by period.
     *
     * `daily` gives one file a day whatever it holds: a busy application writes
     * a gigabyte into one of them, a quiet one leaves 365 tiny files a year.
     * `period` may be hourly, daily, weekly, monthly or never.
     */
    rotating: {
      driver: 'rotating',
      level: env('LOG_LEVEL', 'debug'),
      period: env('LOG_ROTATE_PERIOD', 'daily'),
      maxBytes: Number(env('LOG_MAX_BYTES', 0)),
      maxFiles: 14
    },

    /**
     * Lines to a collector over UDP, RFC 5424.
     *
     * UDP and not the local `/dev/log`, which is a Unix datagram socket and not
     * something the runtime can open — and a collector elsewhere is why syslog
     * is usually reached for anyway.
     */
    syslog: {
      driver: 'syslog',
      level: env('LOG_LEVEL', 'debug'),
      host: env('SYSLOG_HOST', '127.0.0.1'),
      port: Number(env('SYSLOG_PORT', 514)),
      facility: Number(env('SYSLOG_FACILITY', 16))
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
