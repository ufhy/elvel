import { AuthServiceProvider } from '@elysian/auth'
import { BroadcastServiceProvider } from '@elysian/broadcasting'
import { CacheServiceProvider } from '@elysian/cache'
import { ConsoleServiceProvider } from '@elysian/console'
import { Env, env } from '@elysian/core'
import { DatabaseServiceProvider } from '@elysian/database'
import { EncryptionServiceProvider } from '@elysian/encryption'
import { EventServiceProvider } from '@elysian/events'
import { HttpServiceProvider } from '@elysian/http'
import { LogServiceProvider } from '@elysian/log'
import { MailServiceProvider } from '@elysian/mail'
import { NotificationServiceProvider } from '@elysian/notifications'
import { ProcessServiceProvider } from '@elysian/process'
import { QueueServiceProvider } from '@elysian/queue'
import { ScheduleServiceProvider } from '@elysian/scheduler'
import { StorageServiceProvider } from '@elysian/storage'
import { TranslationServiceProvider } from '@elysian/translation'
import { ValidationServiceProvider } from '@elysian/validation'
import { ViewServiceProvider } from '@elysian/view'

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
   * Framework service providers, in boot order. Events and logging come first:
   * everything after them may emit events or write logs while booting.
   *
   * Application providers live in `bootstrap/app.ts` so they boot after these.
   */
  providers: [
    EventServiceProvider,
    LogServiceProvider,
    // Early: notifications, validation messages and views all read through it.
    TranslationServiceProvider,
    EncryptionServiceProvider,
    ConsoleServiceProvider,
    ProcessServiceProvider,
    DatabaseServiceProvider,
    StorageServiceProvider,
    CacheServiceProvider,
    QueueServiceProvider,
    MailServiceProvider,
    // Before notifications: its `broadcast` channel resolves this at build time.
    BroadcastServiceProvider,
    NotificationServiceProvider,
    ScheduleServiceProvider,
    ValidationServiceProvider,
    HttpServiceProvider,
    // Before the view provider: its static handler claims `GET /*`, which would
    // otherwise shadow the auth endpoints.
    AuthServiceProvider,
    ViewServiceProvider
  ]
}
