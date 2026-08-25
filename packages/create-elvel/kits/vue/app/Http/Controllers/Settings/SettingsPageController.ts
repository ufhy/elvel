import { document } from '@elvel/spa'

/**
 * The settings screens, answered with the application's shell.
 *
 * The same arrangement as `Auth/AuthPageController`: `routes/spa.ts` is registered
 * after the auth kit's `routes/settings.ts`, so these `GET` handlers answer the
 * pages while every action — saving a profile, rotating a password, revoking a
 * session, enrolling a second factor — stays with controllers this kit does not
 * touch.
 *
 * These carry no data either. What each screen reads it asks for, under `/api/` —
 * `Api/SettingsController` is the other end. That is the difference between a
 * single-page application and a server-driven one: a payload belongs to the
 * document it was embedded in, so a client navigation arrives with the previous
 * page's data; a request belongs to the page that made it.
 *
 * Which leaves these handlers doing one thing, and it is not rendering: **the
 * guard**. `password.confirm` on three of them is where a borrowed unlocked
 * browser would otherwise do real damage, and it is enforced before any JavaScript
 * loads. The matching API route repeats it, because that is where the data is.
 */
export default class SettingsPageController {
  profile() {
    return document({ title: 'Profile' })
  }

  password() {
    return document({ title: 'Password' })
  }

  appearance() {
    return document({ title: 'Appearance' })
  }

  twoFactor() {
    return document({ title: 'Two-factor' })
  }

  passkeys() {
    return document({ title: 'Passkeys' })
  }

  security() {
    return document({ title: 'Security' })
  }
}
