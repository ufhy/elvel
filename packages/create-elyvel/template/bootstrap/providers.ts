import { CacheServiceProvider } from '@elyvel/cache'
import { ConsoleServiceProvider } from '@elyvel/console'
import { EncryptionServiceProvider } from '@elyvel/encryption'
import { EventServiceProvider } from '@elyvel/events'
import { HttpServiceProvider } from '@elyvel/http'
import { LogServiceProvider } from '@elyvel/log'
import { ScheduleServiceProvider } from '@elyvel/scheduler'
import { TranslationServiceProvider } from '@elyvel/translation'
import { ValidationServiceProvider } from '@elyvel/validation'
import { ViewServiceProvider } from '@elyvel/view'

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
 * of this file with what it needs added; the same is true of `--kit=api`.
 *
 * There is no database here, which is the largest single thing this file leaves
 * out. Measured, the saving is in the install rather than in the build:
 * `@elyvel/database` brings `kysely` with it, some 660 KB of packages an
 * application may never open a connection with, while the bundle does not change
 * at all — a driver is resolved by name at run time, so nothing static reaches
 * it.
 *
 * Adding a database is three steps, and the framework has all three:
 *
 * ```
 * bun add @elyvel/database
 * bun artisan config:publish database
 * ```
 *
 * then a line here for `DatabaseServiceProvider`. After that `make:model`,
 * `migrate` and the rest are registered and behave as they always have.
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
  // Wanted by more than it looks: `throttle` counts requests through it, and
  // `withoutOverlapping()` in `routes/console.ts` takes its lock there.
  CacheServiceProvider,
  ValidationServiceProvider,
  ScheduleServiceProvider,
  HttpServiceProvider,
  ViewServiceProvider
]
