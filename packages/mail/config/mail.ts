import { env } from '@elvel/core'

export default {
  /** Mailer used when none is named. `log` writes the message instead of sending. */
  default: env('MAIL_MAILER', 'log'),

  /** Sender for any mailable whose envelope does not name one. */
  /**
   * Where the mail preview page answers, or `false`.
   *
   * A page that lists every mail this application can send and renders each one,
   * with nothing to install and no second service to run. It is never mounted in
   * production — a page describing every mail you send describes your customers to
   * whoever finds it — so this decides where it lives in development, not whether it
   * is safe there.
   *
   * A mailable joins the list by offering a sample of itself:
   *
   * ```ts
   * static preview() {
   *   return new InvoicePaid({ number: 'INV-001' })
   * }
   * ```
   */
  /**
   * The colours every notification is drawn in — Laravel's mail theme, as values.
   *
   * Only what you name changes; the rest keep the defaults. Values rather than a
   * stylesheet because the components inline their styles as they build: Gmail
   * strips `<style>` blocks, so a stylesheet-driven mail looks right in the preview
   * and unstyled in the inbox.
   *
   * A mailable names its own, since `markdownContent()` is a plain function a
   * worker or a test may call with no application around it.
   *
   * ```ts
   * theme: { accent: { info: '#c9241a' } }
   * ```
   */
  theme: undefined,

  /**
   * The document every notification is wrapped in, over `emailLayout`.
   *
   * For the header a brand puts above every mail. Without this the only way to
   * change the document is `template()` on each message, which for the four the
   * auth package sends means writing four `toMailUsing` callbacks to change one
   * thing they all share.
   *
   * A message that calls `template()` still wins — an explicit instruction beats
   * a default.
   *
   * ```ts
   * layout: (parts, theme) =>
   *   `<html><body style="background:${theme.page};padding:24px;">` +
   *   `<img src="https://acme.test/logo.png" width="120" alt="Acme">` +
   *   `${emailLayout(parts, theme)}</body></html>`
   * ```
   */
  layout: undefined,

  preview: '/_mail',

  from: {
    address: env('MAIL_FROM_ADDRESS', 'hello@example.com'),
    name: env('MAIL_FROM_NAME', 'Elvel')
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
