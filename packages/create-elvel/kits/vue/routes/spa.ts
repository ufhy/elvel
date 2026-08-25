import { Route } from '@elvel/http'
import SessionController from '../app/Http/Controllers/Api/SessionController.ts'
import SettingsController from '../app/Http/Controllers/Api/SettingsController.ts'
import AuthPageController from '../app/Http/Controllers/Auth/AuthPageController.ts'
import DashboardController from '../app/Http/Controllers/DashboardController.ts'
import SettingsPageController from '../app/Http/Controllers/Settings/SettingsPageController.ts'

/**
 * This kit's whole departure from the auth kit it is built on.
 *
 * Two halves. The **pages** here shadow the auth kit's server-rendered ones: the
 * scaffolder names route files after `routes/web.ts` in sorted order, so this file
 * — `spa` — is registered after `auth` and `settings`, and in Elysia the last
 * registration of a path wins. Measured, not assumed.
 *
 * Nothing in `routes/auth.ts` or `routes/settings.ts` is edited or copied to make
 * that work, which is the point: every **action** stays where it was. `POST
 * /sign-in` still calls better-auth, rotates the session and copies the cookie
 * through the auth kit's own controller.
 *
 * The paths taken over are listed rather than matched by pattern. A shadow is
 * deliberate, and a route somebody cannot find the handler for is worse than a
 * list. The guards are repeated for the same reason they have to be: shadowing a
 * handler shadows its middleware too.
 *
 * The other half is `/api/`, which is what the shell reads. `spa.embed` is off, so
 * a document carries no data and each screen asks for its own.
 */
Route.middleware('guest').group(() => {
  Route.get('/sign-in', [AuthPageController, 'signIn'])
  Route.get('/sign-up', [AuthPageController, 'signUp'])
  Route.get('/forgot-password', [AuthPageController, 'forgotPassword'])
  Route.get('/reset-password', [AuthPageController, 'resetPassword'])
  Route.get('/two-factor-challenge', [AuthPageController, 'twoFactorChallenge'])
})

Route.middleware('auth').group(() => {
  Route.get('/verify-email', [AuthPageController, 'verifyEmail'])
  Route.get('/confirm-password', [AuthPageController, 'confirmPassword'])

  Route.get('/dashboard', [DashboardController, 'index'])

  Route.prefix('settings').group(() => {
    Route.get('/profile', [SettingsPageController, 'profile'])
    Route.get('/password', [SettingsPageController, 'password'])
    Route.get('/appearance', [SettingsPageController, 'appearance'])

    Route.middleware('password.confirm').group(() => {
      Route.get('/two-factor', [SettingsPageController, 'twoFactor'])
      Route.get('/passkeys', [SettingsPageController, 'passkeys'])
      Route.get('/security', [SettingsPageController, 'security'])
    })
  })
})

/**
 * What the client reads, and the one endpoint with no guard at all.
 *
 * `GET /api/session` has to answer a guest: the shell carries no CSRF token — a
 * token is per session, and a document carrying one could not be cached — so
 * without an unguarded way to fetch it the sign-in form has nothing to post.
 * Measured as `419 CSRF token mismatch` on a fresh visit.
 */
Route.prefix('api').group(() => {
  Route.get('/session', [SessionController, 'show']).name('api.session')

  Route.middleware('auth').group(() => {
    Route.get('/settings/profile', [SettingsController, 'profile'])

    Route.middleware('password.confirm').group(() => {
      Route.get('/settings/sessions', [SettingsController, 'sessions'])
      Route.get('/settings/passkeys', [SettingsController, 'passkeys'])
      Route.get('/settings/two-factor', [SettingsController, 'twoFactor'])
    })
  })
})
