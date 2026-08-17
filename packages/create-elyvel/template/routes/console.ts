import { schedule } from '@elyvel/scheduler'

/**
 * Scheduled work — the equivalent of Laravel's `routes/console.php`.
 *
 * Imported by `bootstrap/app.ts`, so everything here is registered once the
 * providers have booted. `artisan schedule:run` is what executes it, called
 * every minute by cron:
 *
 * ```
 * * * * * * cd /path/to/app && bun artisan schedule:run >> /dev/null 2>&1
 * ```
 *
 * `artisan schedule:list` shows what is registered and when each entry next
 * runs; `artisan schedule:test` runs one now.
 */
schedule()
  .command('cache:prune')
  .hourly()
  // The database cache store has no expiry of its own — this is what sweeps it.
  .withoutOverlapping()

/**
 * An example, commented out rather than running.
 *
 * ```ts
 * schedule()
 *   .call(async () => {
 *     await Report.nightly()
 *   }, 'nightly report')
 *   .dailyAt('2:00')
 *   .onOneServer()
 * ```
 */
