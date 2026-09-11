import { ServiceProvider } from '@elvel/core'
import { type ClientEvents, HttpClient } from './factory.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    'http.client': HttpClient
  }
}

/**
 * Binds the HTTP client.
 *
 * Named `http.client` rather than `http`, which the server package would want if
 * it ever bound anything. A singleton because the fake's recording lives on it:
 * two instances would mean `assertSent()` reading a different tape from the one
 * the code wrote to.
 */
export class HttpClientServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('http.client', (app) => {
      /**
       * Resolved here rather than inside the client, so the client stays a plain
       * object anybody can construct in a test.
       */
      const events = app.bound('events' as never)
        ? (app.make('events' as never) as ClientEvents)
        : undefined

      return new HttpClient(events)
    })
  }
}
