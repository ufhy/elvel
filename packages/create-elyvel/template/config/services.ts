import { env } from '@elyvel/core'

/**
 * Credentials for third-party services — Laravel's `config/services.php`.
 *
 * A place with one rule: nothing here is a secret, everything here reads one
 * from the environment. Keeping them in a config file rather than scattering
 * `process.env` through the code buys two things — `config:cache` can hold
 * them, and a missing key fails where it is configured rather than deep inside
 * whatever needed it.
 *
 * The mail and storage credentials are not here: they live with the driver that
 * uses them, in `config/mail.ts` and `config/filesystems.ts`, as they do in
 * Laravel.
 */
export default {
  /**
   * ```ts
   * stripe: {
   *   key: env('STRIPE_KEY', ''),
   *   secret: env('STRIPE_SECRET', ''),
   *   webhookSecret: env('STRIPE_WEBHOOK_SECRET', '')
   * }
   * ```
   */
  example: {
    key: env('EXAMPLE_SERVICE_KEY', '')
  }
}
