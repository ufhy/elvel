import { Route } from '@elvel/http'
import { t } from 'elysia'
import PasskeyController from '../app/Http/Controllers/Settings/PasskeyController.ts'
import PasswordController from '../app/Http/Controllers/Settings/PasswordController.ts'
import ProfileController from '../app/Http/Controllers/Settings/ProfileController.ts'
import SecurityController from '../app/Http/Controllers/Settings/SecurityController.ts'
import TwoFactorController from '../app/Http/Controllers/Settings/TwoFactorController.ts'

/**
 * The account pages — Laravel's `routes/settings.php`.
 *
 * Two guards, and the difference between them is the point. `auth` says somebody
 * is signed in; `password.confirm` says somebody is *at the keyboard now*, and
 * everything that could take an account away from its owner sits behind it: the
 * sessions list, the passkeys, the second factor.
 *
 * Profile and password are behind `auth` alone, because each asks for a password
 * in its own form — the same protection arriving a different way.
 */
Route.prefix('settings')
  .name('settings.')
  .middleware('auth')
  .group(() => {
    Route.get('/profile', [ProfileController, 'edit']).name('profile')
    Route.patch('/profile', [ProfileController, 'update'])
      .name('profile.update')
      .validate({ body: t.Object({ name: t.String(), email: t.String() }) })

    Route.delete('/profile', [ProfileController, 'destroy'])
      .name('profile.destroy')
      .validate({ body: t.Object({ password: t.String() }) })

    Route.get('/password', [PasswordController, 'edit']).name('password')

    // Fortify throttles this one at six a minute too: a change form that takes
    // the current password is a place to guess it.
    Route.put('/password', [PasswordController, 'update'])
      .name('password.update')
      .middleware('throttle:6,1')
      .validate({
        body: t.Object({
          current: t.String(),
          password: t.String(),
          password_confirmation: t.String()
        })
      })

    Route.middleware('password.confirm').group(() => {
      Route.get('/security', [SecurityController, 'show']).name('security')
      Route.post('/security/revoke', [SecurityController, 'revoke'])
        .name('security.revoke')
        .validate({ body: t.Object({ id: t.String() }) })

      Route.post('/security/revoke-others', [SecurityController, 'revokeOthers']).name(
        'security.revokeOthers'
      )

      Route.get('/passkeys', [PasskeyController, 'index']).name('passkeys')
      Route.delete('/passkeys', [PasskeyController, 'destroy'])
        .name('passkeys.destroy')
        .validate({ body: t.Object({ id: t.String() }) })

      Route.get('/two-factor', [TwoFactorController, 'show']).name('twoFactor')
      Route.post('/two-factor', [TwoFactorController, 'enable'])
        .name('twoFactor.enable')
        .validate({ body: t.Object({ password: t.String() }) })

      Route.post('/two-factor/confirm', [TwoFactorController, 'confirm'])
        .name('twoFactor.confirm')
        .validate({ body: t.Object({ code: t.String() }) })

      Route.post('/two-factor/recovery-codes', [TwoFactorController, 'recoveryCodes'])
        .name('twoFactor.recoveryCodes')
        .validate({ body: t.Object({ password: t.String() }) })

      Route.delete('/two-factor', [TwoFactorController, 'disable'])
        .name('twoFactor.disable')
        .validate({ body: t.Object({ password: t.String() }) })
    })
  })
