import { document } from '@elvel/spa'

/**
 * Where the application begins — and the only route the client needs.
 *
 * The auth pages are server rendered and answer for themselves: a form posts, the
 * server redirects, and `errors()` and `old()` work as they do in any other
 * application. From here on it is the Vue router, and every address it owns
 * arrives as a 404 that `SpaServiceProvider` answers with this same document.
 *
 * `auth` still guards it in `routes/spa.ts`, so a guest is sent to sign in before
 * the client ever loads — which is why the payload can assume there is somebody
 * there.
 */
export default class DashboardController {
  /**
   * The title is named here, because a document without one shows its URL.
   *
   * `config/spa.ts` ships no `title`, so nothing supplies a default: a page that
   * says nothing renders no `<title>` at all, and the tab reads
   * `localhost:3000/dashboard` until the router replaces it. The icon and the
   * mount point still come from config.
   */
  index() {
    return document({ title: 'Dashboard' })
  }
}
