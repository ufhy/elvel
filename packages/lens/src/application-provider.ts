import { ServiceProvider } from '@elvel/core'
import type { Recorder } from './recorder.ts'

/**
 * The base class an application's own Lens provider extends.
 *
 * This is Telescope's two-provider seam, and the reason for it is that the two
 * decisions nobody can make on an application's behalf both live here: who may
 * read the dashboard, and what is worth recording outside development. Telescope
 * publishes `TelescopeApplicationServiceProvider` into the app as a stub for
 * exactly that, and `lens:install` publishes the same thing.
 *
 * `@elvel/lens` deliberately does not depend on `@elvel/auth`. The gate is a
 * method the published subclass fills in, so an application that authorises
 * with a gate, a header, an IP allow-list or a signed link is equally served,
 * and the recorder stays usable in a queue worker with no HTTP layer at all.
 */
export abstract class LensApplicationServiceProvider extends ServiceProvider {
  register(): void {
    //
  }

  override boot(): void {
    this.gate()

    this.lens().auth((request) => this.authorise(request))
  }

  /**
   * Who may read the dashboard. **Refuses by default.**
   *
   * Telescope's default is `app()->environment('local') || Gate::check(...)`,
   * and the `local` half is not copied. `local` usually means an application
   * somebody is developing on their own machine; here a server with an empty
   * `HOST` binds every interface, so "local" is not a statement about who can
   * reach it. Say yes deliberately.
   */
  protected authorise(_request: Request): boolean | Promise<boolean> {
    return false
  }

  /** Define the ability `authorise` checks, when it checks one. */
  protected gate(): void {
    //
  }

  protected lens(): Recorder {
    return this.app.make('lens')
  }
}
