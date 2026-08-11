import { ServiceProvider } from '@elysian/core'
import { Str } from '@elysian/support'
import { Elysia } from 'elysia'
import { LogManager } from './manager.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    log: LogManager
  }
}

/**
 * Registers the log manager and, optionally, request logging.
 *
 * A base provider: it goes near the front of `config/app.ts` so anything that
 * boots afterwards can log.
 */
export class LogServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('log', (app) => new LogManager(app))
  }

  override boot(): void {
    // Resolve now so a bad channel or level fails at boot, not on first write.
    this.app.make('log').channel()

    if (this.config<boolean>('logging.requests.enabled', false) === false) return

    this.use(this.requestLogger())
  }

  /**
   * Access log as an Elysia plugin.
   *
   * `onAfterResponse` is the only hook that sees the final status, and the
   * request id is generated up front so handlers can log against it too.
   */
  private requestLogger() {
    const channel = this.config<string | undefined>('logging.requests.channel')
    const header = this.config<string>('logging.requests.header', 'x-request-id')

    return new Elysia({ name: 'elysian:request-log' })
      .derive({ as: 'global' }, ({ request }) => {
        const requestId = request.headers.get(header) ?? Str.uuid()

        return { requestId, startedAt: Bun.nanoseconds() }
      })
      .onAfterResponse({ as: 'global' }, ({ request, set, requestId, startedAt }) => {
        const status = Number(set.status ?? 200)
        const duration = Math.round((Bun.nanoseconds() - startedAt) / 1_000) / 1_000

        this.app
          .make('log')
          .channel(channel)
          .log(status >= 500 ? 'error' : 'info', 'request', {
            method: request.method,
            path: new URL(request.url).pathname,
            status,
            duration_ms: duration,
            request_id: requestId
          })
      })
  }
}
