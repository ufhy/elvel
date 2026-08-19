import { env } from '@elvel/core'
import type { Auth } from 'better-auth'

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
 * elvel auth:schema && elvel migrate
 * ```
 */
const config = {
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
    },

    /**
     * Closing an account, which better-auth also keeps behind a switch.
     *
     * Off, `POST /delete-user` answers **404** — so the settings page shows a
     * delete form that can never work and the failure reads as a missing route
     * rather than a missing option. Turned on here because the kit ships that
     * form; an application without one can turn it off again.
     *
     * The current password is asked for at the form, which is what makes this
     * safe to leave enabled: a borrowed unlocked browser cannot close the
     * account.
     */
    deleteUser: {
      enabled: true
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

export default config

/**
 * What this application's auth looks like, said once.
 *
 * The framework cannot know either of these: which endpoints better-auth exposes
 * depends on the plugins above, and what a user row holds depends on the same
 * options plus the schema `auth:schema` generated from them. Declaring them here
 * — beside the config they come from — is what makes `api()` and `userOf()`
 * typed everywhere else, with no cast at any call site.
 *
 * `Auth<typeof config>` is better-auth's own inference: `betterAuth(options)`
 * returns `Auth<Options>`, so this is the real list of endpoints rather than a
 * hand-written claim about it. Enable a plugin and its endpoints appear; call one
 * whose plugin is not enabled and the compiler says so.
 */
declare module '@elvel/auth' {
  interface AuthTypes {
    api: Auth<typeof config>['api']
    user: { id: string; name: string; email: string; emailVerified: boolean }
  }
}
