import { app, config } from '@elvel/core'
import { csrfToken } from '@elvel/http'
import { view } from '@elvel/view'
import { Document } from './document.tsx'

/** What a document is asked to carry beyond the application's own payload. */
export type DocumentOptions = {
  /** Overrides `spa.title` for this response. */
  title?: string

  /** Extra markup for `<head>`, after the asset tags. */
  head?: string

  /** Merged over the registered payload — a page's own props. */
  payload?: Record<string, unknown>

  /** Anything else a `Response` takes. `cache-control` is decided here. */
  init?: ResponseInit
}

/** Builds what every document carries. Async, because it usually reads a database. */
export type PayloadBuilder = () => Promise<Record<string, unknown>> | Record<string, unknown>

/**
 * The document, and the one thing an application has to say about it.
 *
 * `payload()` is registered once and used by every route that renders the
 * document — including the 404 handler, which is most of them in a client-routed
 * application. Registering it twice is how a deep link and the front page end up
 * booting from different data, which is a bug that only shows up on reload.
 *
 * ```ts
 * // app/Providers/AppServiceProvider.ts
 * spa().payload(async () => ({
 *   user: user(),
 *   invoices: user() === null ? null : await firstPage(user().id)
 * }))
 * ```
 */
export class Spa {
  private builder: PayloadBuilder = () => ({})

  /** What every document carries. Called per request, never cached. */
  payload(builder: PayloadBuilder): this {
    this.builder = builder

    return this
  }

  /**
   * Render the document.
   *
   * The CSRF token is added here rather than by the application, because
   * forgetting it is not a visible mistake: the page renders, and the first write
   * comes back 419 from somewhere else entirely.
   *
   * In shell mode nothing is embedded at all — not the payload and not the token.
   * A token is per session, so a shell carrying one would be per session too, and
   * a document that differs per person is a document no cache may keep. That is
   * the whole reason to choose a shell.
   */
  async document(options: DocumentOptions = {}): Promise<Response> {
    const embed = config<boolean>('spa.embed', true) !== false

    const payload = embed
      ? { ...(await this.builder()), ...options.payload, csrf: csrfToken() }
      : undefined

    return view(
      Document,
      {
        entry: config<string>('spa.entry', 'src/main.ts'),
        mountId: config<string>('spa.mountId', 'app'),
        title: options.title ?? config<string>('spa.title', ''),
        /**
         * The application's own `<head>` markup, from config when a caller says
         * nothing.
         *
         * Every document needs it, and not every document is returned by a
         * controller: the exception handler renders one for any unknown path, and it
         * has no options to pass. With this only on the call, a favicon reached the
         * dashboard and nothing else.
         */
        head: options.head ?? config<string>('spa.head', ''),
        payload
      },
      {
        ...options.init,
        headers: {
          /**
           * `no-store` for an embedded payload, and only then.
           *
           * The document names hashed assets *and* carries one session's data, so a
           * shared cache holding it could hand one person's payload to the next. A
           * shell has neither, which is what makes it cacheable — and what makes an
           * installable application possible.
           */
          'cache-control': embed ? 'no-store' : 'public, max-age=0, must-revalidate',
          ...options.init?.headers
        }
      }
    )
  }
}

/** The registered instance — `spa().payload(…)`, `await spa().document()`. */
export function spa(): Spa {
  return app('spa')
}

/**
 * Render the document directly, for a controller that has nothing to add.
 *
 * ```ts
 * export default controller('app').get('/', () => document())
 * ```
 */
export function document(options: DocumentOptions = {}): Promise<Response> {
  return spa().document(options)
}
