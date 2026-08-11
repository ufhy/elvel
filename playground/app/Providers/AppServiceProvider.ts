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
   * Everything is registered by now. Resolve services, share view data, mount
   * Elysia plugins.
   */
  override boot(): void {
    this.app.make('view').share('year', new Date().getFullYear())
  }
}
