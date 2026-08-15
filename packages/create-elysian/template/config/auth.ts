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

  user: {
    /**
     * Changing an address, which better-auth keeps behind its own endpoint.
     *
     * `POST /change-email` — `updateUser` refuses an `email` outright. With a
     * verified address on file the change waits for a link sent to the *old*
     * inbox; an unverified one is replaced at once, since there is nothing to
     * protect yet and a typo at sign-up would otherwise be unfixable.
     */
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: true
      // `sendChangeEmailConfirmation` is filled in by the provider, the same way
      // `sendVerificationEmail` is. Write one here to take it over.
    }
  },

  /** Trusted origins for better-auth's own CSRF checks. */
  trustedOrigins: [env('APP_URL', 'http://localhost:3000')],

  // ------------------------------------------------------- framework middleware
  /** Where the `auth` middleware sends a guest. Laravel's `redirectGuestsTo`. */
  redirectGuestsTo: '/sign-in',

  /** Where the `guest` middleware sends somebody already signed in. */
  redirectUsersTo: '/dashboard',

  /** Where `verified` sends an unconfirmed address. */
  verifyRoute: '/verify-email',

  /** Where `password.confirm` asks, and how long an answer counts for. */
  passwordConfirmRoute: '/confirm-password',
  passwordTimeout: 10800
}
