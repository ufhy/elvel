import type { ApplicationContract, ServiceProviderContract } from '@elysian/contracts'
import type { Elysia } from 'elysia'

/**
 * ServiceProvider — the framework's only extension point.
 *
 * Two phases, same contract as Laravel:
 *   register() — bind into the container. Never resolve anything here; other
 *                providers may not have registered yet.
 *   boot()     — everything is bound. Resolve services, mount Elysia plugins.
 */
export abstract class ServiceProvider implements ServiceProviderContract {
  constructor(protected readonly app: ApplicationContract) {}

  abstract register(): void | Promise<void>

  boot(): void | Promise<void> {}

  /**
   * Compose an Elysia plugin into the application router.
   *
   * Always give the plugin a `name` so Elysia deduplicates it — a provider
   * booted twice (tests, nested `use`) must not register routes twice.
   */
  protected use(plugin: Elysia<any, any, any, any, any, any>): void {
    this.app.router.use(plugin as never)
  }

  protected config<T = unknown>(key: string): T
  protected config<T>(key: string, fallback: T): T
  protected config<T>(key: string, fallback?: T): T {
    return this.app.config.get<T>(key, fallback as T)
  }
}
