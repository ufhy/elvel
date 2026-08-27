import { Route } from '@elvel/http'
import { t } from 'elysia'
import ConfirmPasswordController from '../app/Http/Controllers/Auth/ConfirmPasswordController.ts'
import PasswordResetController from '../app/Http/Controllers/Auth/PasswordResetController.ts'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.ts'
import SignInController from '../app/Http/Controllers/Auth/SignInController.ts'
import TwoFactorChallengeController from '../app/Http/Controllers/Auth/TwoFactorChallengeController.ts'
import VerifyEmailController from '../app/Http/Controllers/Auth/VerifyEmailController.ts'

/**
 * The authentication **actions** — the auth kit's `routes/auth.ts` without its pages.
 *
 * This file replaces that one during scaffolding: the Vue layer is copied over the
 * auth layer, so what you are reading is what a generated application has. Every
 * controller behind these routes is the auth kit's, unedited — `POST /sign-in`
 * still calls better-auth, rotates the session against fixation and copies the
 * cookie through.
 *
 * What is gone is the eight `Route.get` pages. They were the second copy of a list
 * the Vue router already owns, and they had to go rather than be shadowed: an
 * exact route wins over `routes/view.ts`, measured, so a page left here would
 * answer instead of the shell.
 *
 * The **names** went with them, because a name is a page's address and these are
 * not pages. `route('login')` has no answer in this kit and needs none: nothing
 * server-side redirects by name here, and `routes().verify()` refuses to boot on a
 * name pointing at a path no route answers — so a leftover name would be a startup
 * failure, not a silent one.
 *
 * `throttle:6,1` is unchanged on every form that takes a secret and says whether
 * it was right. Six a minute, Fortify's own number. A shell in front of it changes
 * nothing about that: the guessing happens against these endpoints.
 */
Route.prefix('api')
  .middleware('guest')
  .group(() => {
    Route.post('/sign-in', [SignInController, 'store'])
      .middleware('throttle:6,1')
      .validate({
        body: t.Object({
          email: t.String({ format: 'email' }),
          password: t.String({ minLength: 1 })
        })
      })

    Route.post('/sign-up', [RegisterController, 'store'])
      .middleware('throttle:6,1')
      .validate({
        body: t.Object({
          name: t.String({ minLength: 1 }),
          email: t.String({ format: 'email' }),
          password: t.String({ minLength: 1 })
        })
      })

    Route.post('/forgot-password', [PasswordResetController, 'email'])
      .name('password.email')
      .middleware('throttle:6,1')
      .validate({ body: t.Object({ email: t.String({ format: 'email' }) }) })

    Route.post('/reset-password', [PasswordResetController, 'update'])
      .name('password.update')
      .middleware('throttle:6,1')
      .validate({
        body: t.Object({
          token: t.String({ minLength: 1 }),
          password: t.String({ minLength: 1 }),
          password_confirmation: t.String({ minLength: 1 })
        })
      })

    /**
     * A guest, holding a cookie that says which account is halfway in.
     *
     * `guest` and not `auth`: `signInEmail` answers with no session at all when the
     * account has two factors, so there is nobody signed in yet.
     */
    Route.post('/two-factor-challenge', [TwoFactorChallengeController, 'store'])
      .middleware('throttle:6,1')
      .validate({ body: t.Object({ code: t.String({ minLength: 1 }) }) })

    Route.post('/two-factor-challenge/recovery', [TwoFactorChallengeController, 'recovery'])
      .name('two-factor.recovery')
      .middleware('throttle:6,1')
      .validate({ body: t.Object({ code: t.String({ minLength: 1 }) }) })
  })

Route.prefix('api')
  .middleware('auth')
  .group(() => {
    Route.post('/verify-email/resend', [VerifyEmailController, 'resend'])
      .name('verification.send')
      .middleware('throttle:6,1')

    Route.post('/confirm-password', [ConfirmPasswordController, 'store'])
      .middleware('throttle:6,1')
      .validate({ body: t.Object({ password: t.String({ minLength: 1 }) }) })
  })

/**
 * Signing out is guarded by neither.
 *
 * `auth` would answer a signed-out browser with a redirect to sign in, which is a
 * strange thing to do to somebody who asked to leave — and the CSRF check already
 * makes this a request only this application's own pages can send.
 */
Route.prefix('api').group(() => {
  Route.post('/sign-out', [SignInController, 'destroy']).name('logout')
})
