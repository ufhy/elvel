import { AuthServiceProvider } from '@elvel/auth'
import { CacheServiceProvider } from '@elvel/cache'
import { ConsoleServiceProvider } from '@elvel/console'
import { DatabaseServiceProvider } from '@elvel/database'
import { EncryptionServiceProvider } from '@elvel/encryption'
import { EventServiceProvider } from '@elvel/events'
import { HashServiceProvider } from '@elvel/hashing'
import { HttpServiceProvider } from '@elvel/http'
import { LogServiceProvider } from '@elvel/log'
import { MailServiceProvider } from '@elvel/mail'
import { NotificationServiceProvider } from '@elvel/notifications'
import { QueueServiceProvider } from '@elvel/queue'
import { ScheduleServiceProvider } from '@elvel/scheduler'
import { StorageServiceProvider } from '@elvel/storage'
import { TranslationServiceProvider } from '@elvel/translation'
import { ValidationServiceProvider } from '@elvel/validation'
import { ViewServiceProvider } from '@elvel/view'
import { ViteServiceProvider } from '@elvel/vite/provider'

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
  ViewServiceProvider,
  ViteServiceProvider
]
