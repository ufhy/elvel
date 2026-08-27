import { env } from '@elvel/core'

/**
 * A single-page application served by this framework.
 *
 * The client is an ordinary Vite project — `bun create vite` with nothing removed
 * — and the server renders the one document it boots from. There is no protocol
 * between them: no page object, no version header, no `X-` anything. The server
 * answers a document; after that the client asks for JSON like any other caller.
 */
export default {
  /** Where the client mounts. `<div id="app">`, unless your entry says otherwise. */
  mountId: env('SPA_MOUNT', 'app'),

  /**
   * Whether the document carries the first screen's data.
   *
   * `true` is what makes this feel different from a plain single-page application:
   * the server already knows who is asking and what they are about to see, so the
   * first paint has content instead of a spinner. The cost is that the document is
   * then **one person's**, which is why it goes out `no-store`.
   *
   * `false` renders a shell — the same bytes for everybody, and therefore
   * cacheable. That is what an installable, offline-capable application needs, and
   * it costs two requests before the first screen: who am I, and what am I
   * looking at. The CSRF token cannot travel in a shell either, since a token is
   * per session and would make the document per session again.
   *
   * One setting, not two packages. Which one is right is a property of the
   * application, not of the framework.
   */
  embed: env('SPA_EMBED', true),

  /**
   * Paths that answer for themselves, and never with the document.
   *
   * A 404 under one of these is a missing endpoint, and answering it with HTML
   * turns that into a parse error three layers away from the mistake — the
   * expensive kind of confusing.
   */
  apiPrefixes: ['/api/']
}
