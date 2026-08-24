import { controller } from '@elvel/core'
import { middleware } from '@elvel/http'
import { document } from '@elvel/spa'

/**
 * The settings screens, answered with the application's shell.
 *
 * The same arrangement as `Auth/AuthPageController`: mounted after the auth kit's
 * settings controllers, so its `GET` handlers answer the pages while every action —
 * saving a profile, rotating a password, revoking a session, enrolling a second
 * factor — stays with controllers this kit does not touch.
 *
 * These carry no data either. What each screen reads it asks for, under `/api/` —
 * `Api/SettingsController` is the other end. That is the difference between a
 * single-page application and a server-driven one: a payload belongs to the
 * document it was embedded in, so a client navigation arrives with the previous
 * page's data; a request belongs to the page that made it.
 *
 * Which leaves these handlers doing one thing, and it is not rendering: **the
 * guard**. `password.confirm` on three of them is where a borrowed unlocked browser
 * would otherwise do real damage, and it is enforced here before any JavaScript
 * loads. The matching API route repeats it, because that is where the data is.
 */
export default controller('vue-settings-pages')
  .get('/settings/profile', () => document({ title: 'Profile' }), middleware('auth'))

  .get('/settings/password', () => document({ title: 'Password' }), middleware('auth'))

  .get('/settings/appearance', () => document({ title: 'Appearance' }), middleware('auth'))

  .get(
    '/settings/two-factor',
    () => document({ title: 'Two-factor' }),
    middleware('auth', 'password.confirm')
  )

  .get(
    '/settings/passkeys',
    () => document({ title: 'Passkeys' }),
    middleware('auth', 'password.confirm')
  )

  .get(
    '/settings/security',
    () => document({ title: 'Security' }),
    middleware('auth', 'password.confirm')
  )
