import { Env, env } from '@elvel/core'
import { providers } from '../bootstrap/providers.ts'

export default {
  name: env('APP_NAME', 'Elvel'),

  /**
   * Signs cookies and, through HKDF, derives the encryption key.
   *
   * At least 32 characters. `elvel key:generate` writes one.
   */
  key: env('APP_KEY', ''),

  /**
   * Keys that can still *read* what they encrypted, comma-separated.
   *
   * Set the old APP_KEY here after rotating, and existing cookies and encrypted
   * columns keep working while new ones use the new key.
   */
  previousKeys: env('APP_PREVIOUS_KEYS', ''),

  env: env('APP_ENV', 'local'),

  /**
   * Zone the schedule is evaluated in. Every entry inherits it unless it names
   * its own, so "daily at 3am" means one thing across the application.
   */
  timezone: env('APP_TIMEZONE', 'UTC'),

  debug: env('APP_DEBUG', true),

  locale: env('APP_LOCALE', 'en'),

  fallbackLocale: env('APP_FALLBACK_LOCALE', 'en'),

  /**
   * Answer in the language the browser asked for, when we have it.
   *
   * Off by default because it changes what every page returns. On, the request's
   * `Accept-Language` picks from the locales under `lang/`; a middleware can
   * still override it with the signed-in user's own preference by calling
   * `translator.usingLocale()`.
   */
  negotiateLocale: env('APP_NEGOTIATE_LOCALE', false),

  url: env('APP_URL', 'http://localhost:3000'),

  /**
   * Where `asset()` points, when that is not the application itself.
   *
   * Set it to a CDN and every image, font and stylesheet not going through Vite
   * moves with it. Empty means they are served from `public/`.
   */
  assetUrl: env('ASSET_URL', ''),

  port: Env.number('PORT', 3000),

  host: env('HOST', ''),

  /**
   * The providers this application registers.
   *
   * The list itself lives in `bootstrap/providers.ts`, where a starter kit can
   * replace it — and where the comment explains why leaving one out matters here
   *    */
  providers
}
