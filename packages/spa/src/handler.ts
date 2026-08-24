import { config, ExceptionHandler } from '@elvel/core'
import { middlewares } from '@elvel/http'
import { areaFor } from './areas.ts'
import { spa } from './spa.ts'

/**
 * The server's half of client-side routing.
 *
 * A client-routed application owns addresses the server has no routes for —
 * `/invoices`, `/invoices/9` — and somebody who types one, or reloads on one, must
 * get the document rather than a 404. The same document `/` renders, so a deep link
 * boots from the same data.
 *
 * Three earlier shapes are recorded because each looked right and none worked. A
 * `GET /*` route loses to the static file plugin, which already claims that path —
 * measured, `/invoices/9` answered a JSON 404. Registering it earlier instead
 * shadows every real file. And an `onError` hook in a provider never fires at all:
 * the framework wires its own handler into Elysia's error pipeline before any
 * provider registers, and the first handler to answer wins.
 *
 * So this replaces the handler. `render` is the documented seam — Laravel's
 * `Handler::render` in another language — and everything it does not claim goes to
 * `super`.
 */
export class SpaExceptionHandler extends ExceptionHandler {
  override async render(error: unknown, context: { request: Request }): Promise<Response> {
    if (!this.wantsDocument(error, context.request)) return super.render(error, context)

    const area = areaFor(new URL(context.request.url).pathname)

    /**
     * The area's middleware, run here because nothing else will.
     *
     * A prefixed area is a real route and Elysia applies its middleware for it.
     * The **root** area cannot be a route — a `GET /*` loses to the static plugin —
     * so its guard has to run in this handler or not at all, and "not at all" means
     * every address the client router owns is open to anybody. That is the shape
     * Laravel writes as `Route::view('{path}', 'main')->middleware('auth')`.
     *
     * Resolved through the registry rather than imported, so an application's own
     * middleware works here as well as `auth` and `guest` — and so this package
     * needs no dependency on the one that defines them.
     */
    const refused = await this.refusedBy(area?.middleware ?? [], context)
    if (refused) return refused

    return spa().document({ entry: area?.entry, title: area?.title })
  }

  /**
   * The first middleware that answers, if any.
   *
   * A hook may return a `Response` or throw — `authenticate` does the first for a
   * browser and the second for a client asking for JSON. A throw here would climb
   * back into the error pipeline this handler is already inside, so it is caught and
   * rendered like any other error instead.
   */
  private async refusedBy(
    names: string[],
    context: { request: Request }
  ): Promise<Response | undefined> {
    if (names.length === 0) return undefined

    for (const hook of middlewares().resolve(names)) {
      try {
        const answer = await hook(context)

        if (answer instanceof Response) return answer
      } catch (thrown) {
        return super.render(thrown, context)
      }
    }

    return undefined
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
