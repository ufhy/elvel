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
   * The first screen's data travels in the document.
   *
   * That is what makes this feel different from a plain single-page application:
   * the server already knows who is asking, so the first paint has content rather
   * than a spinner. The cost is that the document is then one person's, which is
   * why it goes out `no-store`.
   *
   * `false` renders a shell instead — the same bytes for everybody, and therefore
   * cacheable, which is what an installable application needs. It costs two
   * requests before the first screen.
   */
  embed: env('SPA_EMBED', true),

  /** A 404 under these answers for itself rather than with the document. */
  apiPrefixes: ['/api/'],

  /**
   * Markup every document carries in its `<head>`, after the asset tags.
   *
   * Here rather than on each `document()` call: the document a 404 renders comes
   * from the exception handler, which has no call to hang options on — so an icon
   * named at the call site reached the dashboard and no other page.
   */
  head: env('SPA_HEAD', '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />')
}
