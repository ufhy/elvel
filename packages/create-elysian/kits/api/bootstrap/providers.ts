import { AuthServiceProvider } from '@elysian/auth'
import { CacheServiceProvider } from '@elysian/cache'
import { ConsoleServiceProvider } from '@elysian/console'
import { DatabaseServiceProvider } from '@elysian/database'
import { EncryptionServiceProvider } from '@elysian/encryption'
import { EventServiceProvider } from '@elysian/events'
import { HashServiceProvider } from '@elysian/hashing'
import { HttpServiceProvider } from '@elysian/http'
import { LogServiceProvider } from '@elysian/log'
import { MailServiceProvider } from '@elysian/mail'
import { NotificationServiceProvider } from '@elysian/notifications'
import { QueueServiceProvider } from '@elysian/queue'
import { ScheduleServiceProvider } from '@elysian/scheduler'
import { TranslationServiceProvider } from '@elysian/translation'
import { ValidationServiceProvider } from '@elysian/validation'
import { ViewServiceProvider } from '@elysian/view'

/**
 * The service providers this application registers, in boot order.
 *
 * An API answers JSON, so this is the auth kit's list without the parts that
 * exist for pages — no file storage behind a profile picture. The view provider
 * stays: it is what serves `public/`, and an API still has a favicon and a
 * `robots.txt`.
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
  // Early: notifications and validation messages both read through it.
  TranslationServiceProvider,
  EncryptionServiceProvider,
  HashServiceProvider,
  ConsoleServiceProvider,
  DatabaseServiceProvider,
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
