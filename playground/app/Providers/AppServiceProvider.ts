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
