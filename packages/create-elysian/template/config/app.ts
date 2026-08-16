import { Env, env } from '@elysian/core'
import { providers } from '../bootstrap/providers.ts'

export default {
  name: env('APP_NAME', 'Elysian'),

  /**
   * Signs cookies and, through HKDF, derives the encryption key.
   *
   * At least 32 characters. `artisan key:generate` writes one.
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

  url: env('APP_URL', 'http://localhost:3000'),

  port: Env.number('PORT', 3000),

  host: env('HOST', ''),

  /**
   * The providers this application registers.
   *
   * The list itself lives in `bootstrap/providers.ts`, where a starter kit can
   * replace it — and where the comment explains why leaving one out matters here
   * in a way it does not in Laravel.
   */
  providers
}
