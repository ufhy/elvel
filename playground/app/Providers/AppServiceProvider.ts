import { Limit } from '@elysian/cache'
import { ServiceProvider } from '@elysian/core'
import { SendArticleDigest } from '../Jobs/SendArticleDigest.ts'
import { Article } from '../Models/Article.ts'
import { ArticlePolicy } from '../Policies/ArticlePolicy.ts'

export class AppServiceProvider extends ServiceProvider {
  /**
   * Bind your application services into the container.
   * Do not resolve anything here — other providers may not have registered yet.
   */
  register(): void {
    //
  }

  /**
   * Everything is registered. Resolve services and mount Elysia plugins.
   *
   * Views need nothing here: there is no template scope to share data into, so
   * a component imports whatever it needs directly.
   */
  override boot(): void {
    const gate = this.app.make('gate')

    // Policies are registered rather than discovered: a name convention would
    // mean scanning the filesystem, and an explicit map is one line per model.
    gate.policy(Article, ArticlePolicy)

    // An ability with no model behind it. `allowGuests` is opt-in because
    // TypeScript cannot tell a nullable parameter from a required one at runtime.
    gate.define('view-status-page', () => true, { allowGuests: true })

    gate.define('access-admin', (user) => user?.email === 'admin@example.com')

    // A job may carry a model, and the payload holds only its key — so the
    // worker, which is a different process, needs to know the name.
    this.app.make('queue').models.register(Article)

    this.registerSchedule()
    this.registerLimiters()
  }

  /**
   * Named rate limiters, as `RateLimiter::for(...)` in a Laravel provider.
   *
   * A limiter decides from the request, which is what makes "500 an hour for a
   * signed-in user, 20 for everyone else" one rule instead of two routes.
   */
  private registerLimiters(): void {
    const limits = this.app.make('limiters')

    limits.for('api', ({ user, ip }) =>
      user?.id ? Limit.perMinute(500).by(String(user.id)) : Limit.perMinute(20).by(ip)
    )

    // Two windows at once: a burst ceiling and a daily one. Neither expresses the
    // other, and the request has to satisfy both.
    limits.for('uploads', ({ ip }) => [Limit.perMinute(3).by(ip), Limit.perDay(50).by(ip)])

    // An exemption said out loud rather than by omission.
    limits.for('internal', ({ ip }) =>
      ip === '127.0.0.1' ? Limit.none() : Limit.perMinute(5).by(ip)
    )
  }

  /**
   * The schedule, in one readable place.
   *
   * Nothing here runs on its own: a crontab calls `artisan schedule:run` every
   * minute, or a long-lived process runs `artisan schedule:work`.
   */
  private registerSchedule(): void {
    const schedule = this.app.make('schedule')

    // The database cache store has no expiry of its own — this is what sweeps it.
    schedule
      .command('cache:prune', ['--store', 'database'])
      .hourly()
      .withoutOverlapping()
      .description('Delete expired rows from the database cache store')

    /**
     * Batch records outlive the work they describe.
     *
     * Finished ones are swept daily; cancelled ones need their own window because
     * a cancelled batch never finishes by design — its remaining jobs are skipped
     * as they are reserved, so `prune` alone would never touch it. A week is long
     * enough to still be asked why something was cancelled.
     */
    schedule
      .command('queue:prune-batches', ['--hours', '48', '--cancelled', '168'])
      .daily()
      .withoutOverlapping()
      .description('Drop batch records that are no longer worth keeping')

    /**
     * A forked entry, so a slow task does not hold the minute.
     *
     * Everything else here runs in the scheduler's own process, one after
     * another. This one is spawned as a child running the application's own
     * `artisan`, which is why only a command can do it — a closure cannot be
     * handed to a fresh process.
     */
    schedule
      .command('demo:mark-run', ['background'])
      .everyMinute()
      .runInBackground()
      .description('Prove a scheduled command can run in its own process')

    /**
     * Two entries a minute apart in behaviour, not in timing.
     *
     * Both are due every minute; while `artisan down` is in force only the second
     * runs. That is the useful default: maintenance usually means something is
     * being migrated, and a task that keeps writing through it is how a
     * half-finished migration acquires new rows — while a heartbeat is exactly what
     * you still want.
     */
    schedule
      .call(async () => {
        await this.app.make('cache').store().put('beat:normal', Date.now(), 300)
      }, 'beat:normal')
      .everyMinute()
      .description('Writes a cache key, and stops while the application is down')

    schedule
      .call(async () => {
        await this.app.make('cache').store().put('beat:always', Date.now(), 300)
      }, 'beat:always')
      .everyMinute()
      .evenInMaintenanceMode()
      .description('Writes a cache key even while the application is down')

    // Sessions expire in the cookie, but their files do not delete themselves.
    schedule
      .call(async () => {
        const lifetime = this.app.config.get<number>('session.lifetime', 7200)

        await this.app.make('session.driver').gc(lifetime)
      }, 'sessions:gc')
      .dailyAt('03:10')
      .description('Delete session files older than the configured lifetime')

    // Failed jobs are worth keeping while somebody might retry them, and not
    // forever.
    schedule
      .command('queue:flush', ['--hours', '168'])
      .weekly()
      .description('Forget failed jobs older than a week')

    // A queued job on a schedule: the schedule only dispatches it, so a slow
    // digest cannot hold up the rest of the minute.
    schedule
      .job(new SendArticleDigest({ label: 'nightly' }))
      .dailyAt('02:00')
      .description('Queue the nightly article digest')
  }
}
