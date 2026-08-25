import { config, ExceptionHandler } from '@elvel/core'
import { spa } from './spa.ts'

/**
 * The server's half of client-side routing.
 *
 * A client-routed application owns addresses the server has no routes for —
 * `/invoices`, `/invoices/9` — and somebody who types one, or reloads on one, must
 * get the document rather than a 404. The same document `/` renders, so a deep link
 * boots from the same data.
 *
 * A `GET /*` route is the other way to do this, and it does work — Laravel's
 * `Route::view('{path}', 'main')`. It did not once: `@elysiajs/static` claimed
 * `/*` in development and answered its own misses, so `/invoices/9` came back a
 * JSON 404 there while the same source served the page in production. That was a
 * bug in this framework and it is fixed — `alwaysStatic: true` in
 * `@elvel/view`'s provider, guarded by `packages/view/test/static-fallthrough.test.ts`.
 *
 * What a handler still buys over that route is the four conditions below. A bare
 * `/*` answers a page for `/build/assets/index-abc.js` as well, which is a browser
 * waiting for JavaScript and getting HTML. What the *route* buys is middleware: an
 * admin panel behind `auth` cannot be expressed here. Prefixed routes for those,
 * this for the global fallback.
 *
 * An `onError` hook in a provider is the one shape that cannot work at all: the
 * framework wires its own handler into Elysia's error pipeline before any provider
 * registers, and the first handler to answer wins.
 *
 * So this replaces the handler. `render` is the documented seam — Laravel's
 * `Handler::render` in another language — and everything it does not claim goes to
 * `super`.
 */
export class SpaExceptionHandler extends ExceptionHandler {
  override render(error: unknown, context: { request: Request }): Response | Promise<Response> {
    if (!this.wantsDocument(error, context.request)) return super.render(error, context)

    return spa().document()
  }

  /**
   * Is this a browser asking for a page the client router should answer?
   *
   * Four conditions, and an application that guesses them itself will get one
   * wrong. Each is here because leaving it out broke something.
   */
  protected wantsDocument(error: unknown, request: Request): boolean {
    if (request.method !== 'GET') return false
    if (this.statusFor(error) !== 404) return false

    /**
     * A client asking for JSON keeps its 404.
     *
     * Answering HTML there turns a missing endpoint into a parse error three
     * layers away from the mistake, which is the expensive kind of confusing.
     */
    if (!(request.headers.get('accept') ?? '').includes('text/html')) return false

    const { pathname } = new URL(request.url)

    for (const prefix of config<string[]>('spa.apiPrefixes', ['/api/'])) {
      if (pathname.startsWith(prefix)) return false
    }

    /**
     * A missing file stays missing.
     *
     * Anything with an extension was asked for as a file — a stale
     * `/build/assets/index-abc123.js` from a cached document, a deleted image —
     * and answering the document there hides the mistake behind a page that
     * renders.
     */
    return !/\.[a-z0-9]+$/i.test(pathname)
  }
}
