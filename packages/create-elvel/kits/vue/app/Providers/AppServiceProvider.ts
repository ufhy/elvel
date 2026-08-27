import { user } from '@elvel/auth'
import { config, ServiceProvider } from '@elvel/core'
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
     * Where the guest screens live in this kit.
     *
     * `config/auth.ts` puts all five at the root, which is right for the kit this
     * one is built on and wrong here: `routes/view.ts` serves them from one
     * prefixed route so that one guard covers them and another covers everything
     * else. The auth kit's controllers read these keys rather than spelling an
     * address out, so this is the whole of it — five lines, and not one edit to a
     * controller or a second copy of that config file.
     *
     * `verifyRoute` and `passwordConfirmRoute` stay at the root. Both screens are
     * shown to somebody already signed in, so they belong to the other half —
     * `guest` would have turned their visitor away.
     */
    for (const [key, path] of [
      ['redirectGuestsTo', '/auth/sign-in'],
      ['signUpRoute', '/auth/sign-up'],
      ['forgotPasswordRoute', '/auth/forgot-password'],
      ['resetPasswordRoute', '/auth/reset-password'],
      ['twoFactorRoute', '/auth/two-factor-challenge']
    ]) {
      this.app.config.set(`auth.${key}`, path)
    }

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
        /**
         * The application's name, so the client never hard-codes it.
         *
         * A `.vue` file is copied byte-for-byte by the scaffolder — it cannot carry
         * a `{{ name }}` placeholder, because that is also Vue's interpolation
         * syntax. Sending it means renaming the application is one edit in `.env`
         * rather than a search through the client.
         */
        app: config('app.name', 'Elvel'),
        user: person === null ? null : { id: person.id, name: person.name, email: person.email }
      }
    })
  }
}
