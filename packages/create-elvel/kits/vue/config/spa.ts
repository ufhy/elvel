import { env } from '@elvel/core'

/**
 * The client this application serves, and what its document carries.
 *
 * The client is an ordinary Vite project in `frontend/` — `bun create vite` with
 * nothing removed — and the server renders the one document it boots from. There
 * is no protocol between them: the server answers a document, and after that the
 * client asks for JSON like any other caller.
 */
export default {
  /** The client's entry, as its Vite manifest names it. */
  entry: env('SPA_ENTRY', 'src/main.ts'),

  title: env('SPA_TITLE', '{{ name }}'),

  mountId: env('SPA_MOUNT', 'app'),

  /**
   * A shell: the document carries no data at all.
   *
   * `false` is the choice that makes this a single-page application rather than a
   * server-driven one. The document is the same bytes for everybody, so a cache may
   * keep it, and every page asks for what it needs — `GET /api/session` for who is
   * asking and the CSRF token, then whatever that page reads.
   *
   * `true` embeds the first screen's data instead, which buys a first paint with
   * content and costs the document its cacheability: it is then one person's, and
   * goes out `no-store`. It costs something subtler too, and it is why this kit
   * turned it off — an embedded payload belongs to the *document*, so a client-side
   * navigation arrives carrying the previous page's data.
   */
  embed: env('SPA_EMBED', false),

  /**
   * A 404 under these answers for itself rather than with the document.
   *
   * Load-bearing here: every read this client makes lives under `/api/`, and a
   * missing one has to arrive as a 404 the client can see rather than as HTML it
   * would fail to parse three layers from the mistake.
   */
  apiPrefixes: ['/api/'],

  /**
   * Two regions: the auth screens, and the application behind them.
   *
   * The root area is what `middleware: ['auth']` is here for. Every address the Vue
   * router owns — `/dashboard`, `/settings/profile`, anything you add — is refused
   * to a guest **by the server**, before a byte of JavaScript loads. Without it the
   * only thing standing there is a check in the client router, which is a check
   * running on the visitor's own machine.
   *
   * The auth screens are not an area: they are real routes at the root
   * (`/sign-in`, `/sign-up`, …) with their own `guest` guard, and
   * `Auth/AuthPageController` gives them their own entry — so a guest downloads the
   * auth bundle and not the application behind it.
   */
  areas: [{ path: '/', entry: env('SPA_ENTRY', 'src/main.ts'), middleware: ['auth'] }],

  /**
   * Markup every document carries in its `<head>`, after the asset tags.
   *
   * Here rather than on each `document()` call: the document a 404 renders comes
   * from the exception handler, which has no call to hang options on — so an icon
   * named at the call site reached the dashboard and no other page.
   */
  head: env('SPA_HEAD', '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />')
}
