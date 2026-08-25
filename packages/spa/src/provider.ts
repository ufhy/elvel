import { ServiceProvider } from '@elvel/core'
import { SpaExceptionHandler } from './handler.ts'
import { Spa } from './spa.ts'

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
