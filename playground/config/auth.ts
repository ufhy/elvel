import { env } from '@elvel/core'

/**
 * better-auth's options, plus the few keys the framework reads itself.
 *
 * Everything not listed under "framework" below is passed to better-auth
 * verbatim — its own documentation is the reference for what goes here.
 */
export default {
  // ------------------------------------------------------------- framework
  /** Serve the auth endpoints. Off leaves only the Gate. */
  mount: env('AUTH_MOUNT', true),

  /** Connection the auth tables live on. Undefined means the app's default. */
  connection: undefined,

  /**
   * Send the reset and verification links as notifications.
   *
   * better-auth builds the tokens and URLs and then asks the application to
   * deliver them — it ships no mailer on purpose. Off means writing your own
   * `sendResetPassword` below; a callback written there wins either way.
   */
  notifications: true,

  // ------------------------------------------------------------ better-auth
  /** Signs better-auth's tokens. Never reuse APP_KEY in production. */
  secret: env('AUTH_SECRET', 'playground-auth-secret-at-least-32-chars'),

  baseURL: env('APP_URL', 'http://localhost:3000'),

  basePath: '/api/auth',

  emailAndPassword: {
    enabled: true,
    /** The playground signs up with short passwords; production should not. */
    minPasswordLength: 8
  },

  /** Trusted origins for better-auth's own CSRF checks. */
  trustedOrigins: [env('APP_URL', 'http://localhost:3000')]
}
