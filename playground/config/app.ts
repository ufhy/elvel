import { AuthServiceProvider } from '@elvel/auth'
import { BroadcastServiceProvider } from '@elvel/broadcasting'
import { CacheServiceProvider } from '@elvel/cache'
import { ConcurrencyServiceProvider } from '@elvel/concurrency'
import { ConsoleServiceProvider } from '@elvel/console'
import { Env, env } from '@elvel/core'
import { DatabaseServiceProvider } from '@elvel/database'
import { EncryptionServiceProvider } from '@elvel/encryption'
import { EventServiceProvider } from '@elvel/events'
import { HashServiceProvider } from '@elvel/hashing'
import { HttpServiceProvider } from '@elvel/http'
import { HttpClientServiceProvider } from '@elvel/http-client'
import { ImageServiceProvider } from '@elvel/image'
import { LogServiceProvider } from '@elvel/log'
import { MailServiceProvider } from '@elvel/mail'
import { NotificationServiceProvider } from '@elvel/notifications'
import { ProcessServiceProvider } from '@elvel/process'
import { QueueServiceProvider } from '@elvel/queue'
import { ScheduleServiceProvider } from '@elvel/scheduler'
import { StorageServiceProvider } from '@elvel/storage'
import { TranslationServiceProvider } from '@elvel/translation'
import { ValidationServiceProvider } from '@elvel/validation'
import { ViewServiceProvider } from '@elvel/view'

export default {
  /** Default language, and what to fall back to when a key is missing. */
  locale: env('APP_LOCALE', 'en'),
  fallbackLocale: env('APP_FALLBACK_LOCALE', 'en'),

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
