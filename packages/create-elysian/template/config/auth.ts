import { env } from '@elysian/core'

/**
 * better-auth's options, plus the few keys the framework reads itself.
 *
 * Everything not listed under "framework" below is passed to better-auth
 * verbatim — its own documentation is the reference for what goes here.
 *
 * The tables are generated rather than shipped, because what they are depends on
 * the options and plugins here:
 *
 * ```
 * artisan auth:schema && artisan migrate
 * ```
 */
export default {
  // ------------------------------------------------------------- framework
  /** Serve the auth endpoints. Off leaves only the Gate. */
  mount: env('AUTH_MOUNT', true),

  /** Connection the auth tables live on. Undefined means the app's default. */
  connection: undefined,

  // ------------------------------------------------------------ better-auth
  /** Signs better-auth's tokens. Never reuse APP_KEY, and never ship this default. */
  secret: env('AUTH_SECRET', ''),

  baseURL: env('APP_URL', 'http://localhost:3000'),

  basePath: '/api/auth',

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8
  },

  /** Trusted origins for better-auth's own CSRF checks. */
  trustedOrigins: [env('APP_URL', 'http://localhost:3000')]
}
