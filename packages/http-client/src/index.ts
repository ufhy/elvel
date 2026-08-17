/**
 * An HTTP client — retries, timeouts, a pool, and something to assert against.
 *
 * `fetch` is already in Bun, and this is what it does not give you: a retry
 * policy that knows a 422 is not worth repeating, a timeout that actually
 * cancels, a response object with `failed()` and `throw()`, and a fake with
 * `assertSent` so a test of code that calls an API does not call the API.
 *
 * A separate package from `@elvel/http` on purpose. That one is the server —
 * sessions, cookies, CSRF — and a queue worker making an outbound call has no
 * business loading it.
 */
export { type FakeDefinition, fakeResponse, HttpClient } from './factory.ts'
export { http } from './helpers.ts'
export {
  type Attempt,
  type BunOptions,
  type Method,
  PendingRequest,
  type RequestOptions,
  type Responder,
  type RetryOptions,
  type RetryWhen
} from './pending.ts'
export { HttpClientServiceProvider } from './provider.ts'
export { ConnectionError, HttpResponse, RequestError } from './response.ts'
