import { AuthServiceProvider } from '@elyvel/auth'
import { BroadcastServiceProvider } from '@elyvel/broadcasting'
import { CacheServiceProvider } from '@elyvel/cache'
import { ConcurrencyServiceProvider } from '@elyvel/concurrency'
import { ConsoleServiceProvider } from '@elyvel/console'
import { Env, env } from '@elyvel/core'
import { DatabaseServiceProvider } from '@elyvel/database'
import { EncryptionServiceProvider } from '@elyvel/encryption'
import { EventServiceProvider } from '@elyvel/events'
import { HashServiceProvider } from '@elyvel/hashing'
import { HttpServiceProvider } from '@elyvel/http'
import { HttpClientServiceProvider } from '@elyvel/http-client'
import { ImageServiceProvider } from '@elyvel/image'
import { LogServiceProvider } from '@elyvel/log'
import { MailServiceProvider } from '@elyvel/mail'
import { NotificationServiceProvider } from '@elyvel/notifications'
import { ProcessServiceProvider } from '@elyvel/process'
import { QueueServiceProvider } from '@elyvel/queue'
import { ScheduleServiceProvider } from '@elyvel/scheduler'
import { StorageServiceProvider } from '@elyvel/storage'
import { TranslationServiceProvider } from '@elyvel/translation'
import { ValidationServiceProvider } from '@elyvel/validation'
import { ViewServiceProvider } from '@elyvel/view'

export default {
  /** Default language, and what to fall back to when a key is missing. */
  locale: env('APP_LOCALE', 'en'),
  fallbackLocale: env('APP_FALLBACK_LOCALE', 'en'),

  name: env('APP_NAME', 'Elyvel'),

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
   * Framework service providers, in boot order. Events and logging come first:
   * everything after them may emit events or write logs while booting.
   *
   * Application providers live in `bootstrap/app.ts` so they boot after these.
   */
  providers: [
    BroadcastServiceProvider,
    TranslationServiceProvider,
    EventServiceProvider,
    LogServiceProvider,
    EncryptionServiceProvider,
    HashServiceProvider,
    ConsoleServiceProvider,
    ConcurrencyServiceProvider,
    ProcessServiceProvider,
    DatabaseServiceProvider,
    StorageServiceProvider,
    ImageServiceProvider,
    CacheServiceProvider,
    QueueServiceProvider,
    MailServiceProvider,
    NotificationServiceProvider,
    ScheduleServiceProvider,
    ValidationServiceProvider,
    HttpServiceProvider,
    HttpClientServiceProvider,
    // Before the view provider: its static handler claims `GET /*`, which would
    // otherwise shadow the auth endpoints.
    AuthServiceProvider,
    ViewServiceProvider
  ]
}
