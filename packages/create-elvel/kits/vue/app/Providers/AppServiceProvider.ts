import { ServiceProvider } from '@elvel/core'

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
  }
}
