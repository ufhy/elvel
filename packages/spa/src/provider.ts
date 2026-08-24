import { ServiceProvider } from '@elvel/core'
import { middleware } from '@elvel/http'
import { Elysia } from 'elysia'
import { normalise, prefixedAreas } from './areas.ts'
import { SpaExceptionHandler } from './handler.ts'
import { Spa, spa } from './spa.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    spa: Spa
  }
}

/**
 * Binds the document, and makes a deep link answer with it.
 *
 * ```ts
 * // bootstrap/providers.ts
 * export default [SpaServiceProvider, …]
 * ```
 */
export class SpaServiceProvider extends ServiceProvider {
  /**
   * Mount a real route for every area that can have one.
   *
   * Two per area, and the second is not redundant: `/admin-panel/*` does not match
   * `/admin-panel` itself, so without the bare prefix the area's own front door
   * falls through to the root shell. Laravel's version of this file writes the same
   * pair — `Route::view('{any}', …)` and `Route::view('', …)`.
   *
   * The root area gets none of this, because a `GET /*` loses to the static file
   * plugin in development. It is answered by `SpaExceptionHandler` instead.
   *
   * In `boot`, so `config` is populated and the routes land before the
   * application's own — which is what lets an application take an address back by
   * declaring it, since the last registration of a path wins.
   */
  override async boot(): Promise<void> {
    const mounted = prefixedAreas()

    if (mounted.length === 0) return

    let routes = new Elysia({ name: 'spa:areas' })

    for (const area of mounted) {
      const prefix = normalise(area.path)
      const shell = () => spa().document({ entry: area.entry, title: area.title })
      const guards = middleware(...(area.middleware ?? []))

      routes = routes.get(`${prefix}/*`, shell, guards).get(prefix, shell, guards)
    }

    this.use(routes)
  }

  register(): void {
    this.app.instance('spa', new Spa())

    /**
     * Rebound in `register`, not `boot`.
     *
     * The http provider reads `exception.handler` while it wires Elysia's error
     * pipeline, and a swap after that has already missed its moment — measured as
     * a deep link answering a JSON 404 from a handler that had been replaced.
     */
    this.app.instance('exception.handler', new SpaExceptionHandler(this.app))
  }
}
