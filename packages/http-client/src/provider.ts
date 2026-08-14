import { ServiceProvider } from '@elysian/core'
import { HttpClient } from './factory.ts'

declare module '@elysian/contracts' {
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
    this.app.singleton('http.client', () => new HttpClient())
  }
}
