import { CacheServiceProvider } from '@elysian/cache'
import { ConsoleServiceProvider } from '@elysian/console'
import { DatabaseServiceProvider } from '@elysian/database'
import { EncryptionServiceProvider } from '@elysian/encryption'
import { EventServiceProvider } from '@elysian/events'
import { HttpServiceProvider } from '@elysian/http'
import { LogServiceProvider } from '@elysian/log'
import { ScheduleServiceProvider } from '@elysian/scheduler'
import { TranslationServiceProvider } from '@elysian/translation'
import { ValidationServiceProvider } from '@elysian/validation'
import { ViewServiceProvider } from '@elysian/view'

/**
 * The service providers this application registers, in boot order.
 *
 * Laravel keeps its equivalent here too — `bootstrap/providers.php` — though for
 * a different reason: there, `laravel/framework` registers its own providers and
 * the file lists only the application's. Here every provider is named, because
 * every one of them lives in a package of its own.
 *
 * That difference is the whole point of this file. A provider named here is a
 * package imported, installed, and bundled; a provider left out is a package the
 * application never pays for. Laravel can afford to register all of Eloquent,
 * Queue and Mail in an application that uses none of them, because the code
 * arrived in `vendor/` regardless. Measured here, registering all twenty-two
 * took a landing page from 1.0 MB to 3.7 MB — most of it `kysely` behind the
 * database, `nodemailer` behind mail, and better-auth behind auth.
 *
 * So this is the list a starter kit changes. `--kit=auth` ships its own version
 * of this file with what it needs added; the same is true of `--kit=api`. Add a
 * line here when you start using something, and the package it names is already
 * a dependency — nothing else has to happen.
 *
 * Order matters in two places, both noted below. Everything else is grouped by
 * what it is rather than by what it needs.
 */
export const providers = [
  // Events and logging first: everything after them may emit an event or write
  // a log line while it boots.
  EventServiceProvider,
  LogServiceProvider,
  // Early: validation messages and views both read through it.
  TranslationServiceProvider,
  EncryptionServiceProvider,
  ConsoleServiceProvider,
  DatabaseServiceProvider,
  // Wanted by more than it looks: `throttle` counts requests through it, and
  // `withoutOverlapping()` in `routes/console.ts` takes its lock there.
  CacheServiceProvider,
  ValidationServiceProvider,
  ScheduleServiceProvider,
  HttpServiceProvider,
  ViewServiceProvider
]
