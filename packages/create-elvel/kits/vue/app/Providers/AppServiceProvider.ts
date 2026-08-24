import { user } from '@elvel/auth'
import { ServiceProvider } from '@elvel/core'
import { spa } from '@elvel/spa'

export class AppServiceProvider extends ServiceProvider {
  /**
   * Bind your application services into the container.
   * Do not resolve anything here — other providers may not have registered yet.
   */
  register(): void {
    //
  }

  override boot(): void {
    /**
     * What every document carries, declared once.
     *
     * Every address the Vue router owns arrives as a 404 and leaves as the same
     * document, so `/dashboard` and a deep link into it have to boot from the same
     * data. Building it in each route instead is how the two end up disagreeing —
     * a bug that only appears on reload, and only for whoever reloads.
     *
     * Add what your first screen needs here. It runs per request, so it can read
     * the database; keep it to what the first paint actually uses.
     */
    spa().payload(() => {
      const person = user()

      return {
        user: person === null ? null : { id: person.id, name: person.name, email: person.email }
      }
    })
  }
}
