import { env } from '@elyvel/core'

export default {
  /** Mailer used when none is named. `log` writes the message instead of sending. */
  default: env('MAIL_MAILER', 'log'),

  /** Sender for any mailable whose envelope does not name one. */
  from: {
    address: env('MAIL_FROM_ADDRESS', 'hello@example.com'),
    name: env('MAIL_FROM_NAME', 'Elyvel')
  },

  /**
   * Deliver everything here instead, keeping the real recipients in headers.
   *
   * Leave it unset in production. On a staging copy of production data it is the
   * difference between a test send and mail reaching real customers.
   */
  alwaysTo: env('MAIL_ALWAYS_TO', '') || undefined,

  mailers: {
    /** Writes to the log channel. The right default while developing. */
    log: { transport: 'log' },

    /** Keeps messages in memory, for tests. */
    array: { transport: 'array' },

    smtp: {
      transport: 'smtp',
      host: env('MAIL_HOST', '127.0.0.1'),
      port: Number(env('MAIL_PORT', 1025)),
      username: env('MAIL_USERNAME', '') || undefined,
      password: env('MAIL_PASSWORD', '') || undefined,
      /**
       * Only for a local mail catcher with a self-signed certificate. The manager
       * refuses to honour it in production.
       */
      allowSelfSigned: env('MAIL_ALLOW_SELF_SIGNED', false)
    },

    resend: { transport: 'resend', key: env('RESEND_KEY', '') },

    /** Try SMTP, fall back to writing the message to the log. */
    failover: { transport: 'failover', mailers: ['smtp', 'log'] }
  }
}
