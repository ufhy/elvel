import { env } from '@elysian/core'

export default {
  /**
   * Where `view('pages.landing')` looks for `pages/landing.edge`.
   * Leave unset to use `resources/views`.
   */
  path: undefined,

  /** Extra named disks: `{ emails: '...' }` renders as `emails::welcome`. */
  disks: {},

  /**
   * Compile cache. Edge caches compiled templates in memory only — there is no
   * on-disk compiled-view directory — so this is per process. Off in local dev
   * so template edits show up on reload.
   */
  cache: env('VIEW_CACHE', false),

  /** Values injected into every template. */
  globals: {},

  /** Serve `public/` through @elysiajs/static. */
  serveStatic: true,

  staticPrefix: '/'
}
