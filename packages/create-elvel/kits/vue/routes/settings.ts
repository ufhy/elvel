import { Route } from '@elvel/http'
import { t } from 'elysia'
import PasskeyController from '../app/Http/Controllers/Settings/PasskeyController.ts'
import PasswordController from '../app/Http/Controllers/Settings/PasswordController.ts'
import ProfileController from '../app/Http/Controllers/Settings/ProfileController.ts'
import SecurityController from '../app/Http/Controllers/Settings/SecurityController.ts'
import TwoFactorController from '../app/Http/Controllers/Settings/TwoFactorController.ts'

/**
 * The account **actions** — the auth kit's `routes/settings.ts` without its pages.
 *
 * Five `Route.get` pages are gone for the reason the auth ones are: the Vue router
 * owns `/settings/*`, and what a screen needs to render arrives from
 * `routes/api.ts` instead. The controllers are the auth kit's, unedited.
 *
 * Two guards, and the difference between them is still the point. `auth` says
 * somebody is signed in; `password.confirm` says somebody is *at the keyboard
 * now*, and everything that could take an account away from its owner sits behind
 * it — including the reads in `routes/api.ts`, which is where a shell learns it
 * has to ask.
 *
 * Profile and password are behind `auth` alone, because each asks for a password
 * in its own form: the same protection arriving a different way.
 */
Route.prefix('api/settings')
  .name('settings.')
  .middleware('auth')
  .group(() => {
    Route.patch('/profile', [ProfileController, 'update'])
      .name('profile.update')
      .validate({
        body: t.Object({ name: t.String({ minLength: 1 }), email: t.String({ format: 'email' }) })
      })

    Route.delete('/profile', [ProfileController, 'destroy'])
      .name('profile.destroy')
      .validate({ body: t.Object({ password: t.String({ minLength: 1 }) }) })

    // Fortify throttles this one at six a minute too: a change form that takes
    // the current password is a place to guess it.
    Route.put('/password', [PasswordController, 'update'])
      .name('password.update')
      .middleware('throttle:6,1')
      .validate({
        body: t.Object({
          current: t.String({ minLength: 1 }),
          password: t.String({ minLength: 1 }),
          password_confirmation: t.String({ minLength: 1 })
        })
      })

    Route.middleware('password.confirm').group(() => {
      Route.post('/security/revoke', [SecurityController, 'revoke'])
        .name('security.revoke')
        .validate({ body: t.Object({ id: t.String({ minLength: 1 }) }) })

      Route.post('/security/revoke-others', [SecurityController, 'revokeOthers']).name(
        'security.revokeOthers'
      )

      Route.delete('/passkeys', [PasskeyController, 'destroy'])
        .name('passkeys.destroy')
        .validate({ body: t.Object({ id: t.String({ minLength: 1 }) }) })

      Route.post('/two-factor', [TwoFactorController, 'enable'])
        .name('twoFactor.enable')
        .validate({ body: t.Object({ password: t.String({ minLength: 1 }) }) })

      Route.post('/two-factor/confirm', [TwoFactorController, 'confirm'])
        .name('twoFactor.confirm')
        .validate({ body: t.Object({ code: t.String({ minLength: 1 }) }) })

      Route.post('/two-factor/recovery-codes', [TwoFactorController, 'recoveryCodes'])
        .name('twoFactor.recoveryCodes')
        .validate({ body: t.Object({ password: t.String({ minLength: 1 }) }) })

      Route.delete('/two-factor', [TwoFactorController, 'disable'])
        .name('twoFactor.disable')
        .validate({ body: t.Object({ password: t.String({ minLength: 1 }) }) })
    })
  })
