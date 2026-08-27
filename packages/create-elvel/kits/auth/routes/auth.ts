import { Route } from '@elvel/http'
import { t } from 'elysia'
import ConfirmPasswordController from '../app/Http/Controllers/Auth/ConfirmPasswordController.ts'
import PasswordResetController from '../app/Http/Controllers/Auth/PasswordResetController.ts'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.ts'
import SignInController from '../app/Http/Controllers/Auth/SignInController.ts'
import TwoFactorChallengeController from '../app/Http/Controllers/Auth/TwoFactorChallengeController.ts'
import VerifyEmailController from '../app/Http/Controllers/Auth/VerifyEmailController.ts'
import DashboardController from '../app/Http/Controllers/DashboardController.ts'

/**
 * The authentication routes — Laravel's `routes/auth.php`.
 *
 * Its own file because that is where a reader looks for them, and because the
 * split is what stopped `routes/web.ts` becoming the 619-line file this kit's
 * controllers were carved out of.
 *
 * `throttle:6,1` is on every form that takes a secret and answers whether it was
 * right — six a minute, which is Fortify's own number. Without it each of these
 * is a guessing oracle: a password, a six-digit code, a recovery code.
 *
 * The names live here rather than in the controllers. `route('login')` is what the
 * welcome page and every redirect ask for, and `routes().verify()` refuses to boot
 * if a name points at a path no route answers — so renaming a path without its
 * name is a startup failure rather than a 404 somebody finds later.
 */
Route.middleware('guest').group(() => {
  Route.get('/sign-in', [SignInController, 'create']).name('login')
  Route.post('/sign-in', [SignInController, 'store'])
    .middleware('throttle:6,1')
    .validate({
      body: t.Object({ email: t.String({ format: 'email' }), password: t.String({ minLength: 1 }) })
    })

  Route.get('/sign-up', [RegisterController, 'create']).name('register')
  Route.post('/sign-up', [RegisterController, 'store'])
    .middleware('throttle:6,1')
    .validate({
      body: t.Object({
        name: t.String({ minLength: 1 }),
        email: t.String({ format: 'email' }),
        password: t.String({ minLength: 1 })
      })
    })

  Route.get('/forgot-password', [PasswordResetController, 'request']).name('password.request')
  Route.post('/forgot-password', [PasswordResetController, 'email'])
    .name('password.email')
    .middleware('throttle:6,1')
    .validate({ body: t.Object({ email: t.String({ format: 'email' }) }) })

  Route.get('/reset-password', [PasswordResetController, 'reset']).name('password.reset')
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
  Route.get('/two-factor-challenge', [TwoFactorChallengeController, 'create']).name('two-factor')
  Route.post('/two-factor-challenge', [TwoFactorChallengeController, 'store'])
    .middleware('throttle:6,1')
    .validate({ body: t.Object({ code: t.String({ minLength: 1 }) }) })

  Route.post('/two-factor-challenge/recovery', [TwoFactorChallengeController, 'recovery'])
    .name('two-factor.recovery')
    .middleware('throttle:6,1')
    .validate({ body: t.Object({ code: t.String({ minLength: 1 }) }) })
})

Route.middleware('auth').group(() => {
  Route.get('/dashboard', [DashboardController, 'index']).name('dashboard')

  Route.get('/verify-email', [VerifyEmailController, 'notice']).name('verification.notice')
  Route.post('/verify-email/resend', [VerifyEmailController, 'resend'])
    .name('verification.send')
    .middleware('throttle:6,1')

  Route.get('/confirm-password', [ConfirmPasswordController, 'show']).name('password.confirm')
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
Route.post('/sign-out', [SignInController, 'destroy']).name('logout')
