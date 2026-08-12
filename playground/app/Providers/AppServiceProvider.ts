import { ServiceProvider } from '@elysian/core'
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
  }
}
