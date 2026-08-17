import { AuthServiceProvider } from '@elyvel/auth'
import { CacheServiceProvider } from '@elyvel/cache'
import { ConsoleServiceProvider } from '@elyvel/console'
import { DatabaseServiceProvider } from '@elyvel/database'
import { EncryptionServiceProvider } from '@elyvel/encryption'
import { EventServiceProvider } from '@elyvel/events'
import { HashServiceProvider } from '@elyvel/hashing'
import { HttpServiceProvider } from '@elyvel/http'
import { LogServiceProvider } from '@elyvel/log'
import { MailServiceProvider } from '@elyvel/mail'
import { NotificationServiceProvider } from '@elyvel/notifications'
import { QueueServiceProvider } from '@elyvel/queue'
import { ScheduleServiceProvider } from '@elyvel/scheduler'
import { StorageServiceProvider } from '@elyvel/storage'
import { TranslationServiceProvider } from '@elyvel/translation'
import { ValidationServiceProvider } from '@elyvel/validation'
import { ViewServiceProvider } from '@elyvel/view'

/**
 * The service providers this application registers, in boot order.
 *
 * The base template's version of this file is shorter. This kit adds what
 * signing in actually needs: somewhere to keep the users, somewhere to send a
 * verification link, and a queue to send it from.
 *
 * Left out on purpose — `broadcasting`, `concurrency`, `http-client`, `image`
 * and `process` — because nothing here reaches for them, and each one is a
 * package this application would otherwise install and bundle. Add a line when
 * that stops being true.
 */
export const providers = [
  // Events and logging first: everything after them may emit an event or write
  // a log line while it boots.
  EventServiceProvider,
  LogServiceProvider,
  // Early: notifications, validation messages and views all read through it.
  TranslationServiceProvider,
  EncryptionServiceProvider,
  HashServiceProvider,
  ConsoleServiceProvider,
  DatabaseServiceProvider,
  StorageServiceProvider,
  // Wanted by more than it looks: `throttle` counts requests through it, and
  // `withoutOverlapping()` in `routes/console.ts` takes its lock there.
  CacheServiceProvider,
  QueueServiceProvider,
  MailServiceProvider,
  NotificationServiceProvider,
  ValidationServiceProvider,
  ScheduleServiceProvider,
  HttpServiceProvider,
  // Before the view provider: its static handler claims `GET /*`, which would
  // otherwise shadow the auth endpoints.
  AuthServiceProvider,
  ViewServiceProvider
]
