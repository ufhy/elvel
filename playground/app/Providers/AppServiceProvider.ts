import { ServiceProvider } from '@elysian/core'

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
    //
  }
}
