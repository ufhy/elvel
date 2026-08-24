import { controller } from '@elvel/core'
import { middleware, routes } from '@elvel/http'
import { document } from '@elvel/spa'

/**
 * Where the application begins — and the only route the client needs.
 *
 * The auth pages above this are server rendered and answer for themselves: a form
 * posts, the server redirects, and `errors()` and `old()` work as they do in any
 * other application. From here on it is the Vue router, and every address it owns
 * arrives as a 404 that `SpaServiceProvider` answers with this same document.
 *
 * `auth` still guards it, so a guest is sent to sign in before the client ever
 * loads — which is why the payload can assume there is somebody there.
 */
routes().names({ dashboard: '/dashboard' })

export default controller('dashboard').get(
  '/dashboard',
  // The icon, the title and the mount point all come from `config/spa.ts`, so
  // every document carries them — including the one a 404 renders.
  () => document(),
  middleware('auth')
)
