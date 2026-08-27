import { app, config } from '@elvel/core'
import { csrfToken } from '@elvel/http'
import { view } from '@elvel/view'
import { Document } from './document.tsx'

/** What a document is asked to carry beyond the application's own payload. */
export type DocumentOptions = {
  /** Overrides `spa.title` for this response. */
  title?: string

  /**
   * Overrides `spa.entry` — the Vite entry this shell loads.
   *
   * One entry per area, which is the point of declaring areas at all: a guest on
   * the sign-in screen downloads the auth bundle and not the application behind it.
   */
  entry?: string

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
        /**
         * The entry, from the caller or from the default.
         *
         * `config/spa.ts` no longer ships an `entry` key: every application the
         * scaffolder writes names its client `src/main.ts`, so the key only ever
         * repeated this default. A page that boots from a different bundle says so
         * where it is rendered — `document({ entry: 'src/auth.ts' })` — which is how
         * the auth screens in `--kit=vue` get a bundle of their own.
         *
         * The read stays, so an application that renames its client can add
         * `entry:` back to its own `config/spa.ts`. That is the one thing a call
         * site cannot cover: the document a 404 renders comes from the exception
         * handler, which has no arguments to pass.
         */
        entry: options.entry ?? config<string>('spa.entry', 'src/main.ts'),
        mountId: config<string>('spa.mountId', 'app'),
        /**
         * The title, from the caller — and nothing supplies a default.
         *
         * `config/spa.ts` ships no `title` key, so a page that names none renders no
         * `<title>` at all and the tab shows the URL. That is the honest outcome: a
         * shell has no idea what page it is about to become, and a single title for
         * every address is wrong on all but one of them.
         *
         * Name it where the page is rendered. The one address that cannot — anything
         * the client router owns, answered by the exception handler — is named by the
         * client instead, from its own route.
         *
         * The read stays, so an application that wants one fallback can add
         * `title:` back to its own config.
         */
        title: options.title ?? config<string>('spa.title', ''),
        /**
         * `<head>` markup, from the caller only.
         *
         * There was a `spa.head` config key behind this. It was there because the
         * exception handler renders a document for any unknown path and has no
         * options to hang an icon on — but an application that answers its own
         * addresses with `Route.view` passes the markup where it renders, and one
         * that does not can put the icon in its own `Document` wrapper. A config
         * key read on every document to serve a case one route makes disappear was
         * not worth its own knob.
         */
        head: options.head ?? '',
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
 * // routes/web.ts
 * Route.get('/', () => document())
 * Route.get('/dashboard', [DashboardController, 'index']).middleware('auth')
 * ```
 */
export function document(options: DocumentOptions = {}): Promise<Response> {
  return spa().document(options)
}
