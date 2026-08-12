import { AuthServiceProvider } from '@elysian/auth'
import { CacheServiceProvider } from '@elysian/cache'
import { ConsoleServiceProvider } from '@elysian/console'
import { Env, env } from '@elysian/core'
import { DatabaseServiceProvider } from '@elysian/database'
import { EventServiceProvider } from '@elysian/events'
import { HttpServiceProvider } from '@elysian/http'
import { LogServiceProvider } from '@elysian/log'
import { QueueServiceProvider } from '@elysian/queue'
import { ScheduleServiceProvider } from '@elysian/scheduler'
import { ValidationServiceProvider } from '@elysian/validation'
import { ViewServiceProvider } from '@elysian/view'

export default {
  name: env('APP_NAME', 'Elysian'),

  /** Signs session cookies. Must be at least 32 characters in production. */
  key: env('APP_KEY', ''),

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
    ConsoleServiceProvider,
    DatabaseServiceProvider,
    CacheServiceProvider,
    QueueServiceProvider,
    ScheduleServiceProvider,
    ValidationServiceProvider,
    HttpServiceProvider,
    // Before the view provider: its static handler claims `GET /*`, which would
    // otherwise shadow the auth endpoints.
    AuthServiceProvider,
    ViewServiceProvider
  ]
}
