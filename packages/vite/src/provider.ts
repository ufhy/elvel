import { join } from 'node:path'
import { NotFoundException, ServiceProvider } from '@elvel/core'
import { Elysia } from 'elysia'

/**
 * A miss under the build directory stays a miss.
 *
 * `@elvel/view` serves what is in `public/` with `alwaysStatic: true`, which means
 * its route table holds only files that exist and anything else falls through to
 * the router. That is deliberate, and right everywhere but here: it is the shape of
 * nginx's `try_files $uri $uri/ /index.php`, and it is what lets a client-routed
 * application answer `/invoices/9`.
 *
 * Under the build directory it is wrong. Nothing lives there but output with a
 * content hash in its name, so a request for one that is gone is a cached document
 * asking for yesterday's bundle — and falling through hands it whatever the
 * application's catch-all renders. Measured: `/build/assets/index-abc123.js`
 * answered `200` and a page of HTML, so a browser waiting for JavaScript got markup
 * and the application failed with nothing saying why.
 *
 * A provider rather than something an application writes in a routes file. Every
 * application serving a build wants this, and one that has to know it exists will
 * find out the way described above. `vite.guardBuildDirectory: false` turns it off,
 * and that switch is the whole reason the key is worth having — with a hand-written
 * route the call *was* the switch, and the config said the same thing twice.
 *
 * **Registered after `ViewServiceProvider`**, which is what serves the files that
 * are there. Ahead of it, this would answer for them too.
 */
export class ViteServiceProvider extends ServiceProvider {
  /**
   * The headers one built file needs, for whoever serves `public/`.
   *
   * `@elvel/view` reads `assets.headers` from the container when it mounts its
   * static layer, the same way it reads the security headers — a served file skips
   * the surrounding lifecycle, so a header set globally never reaches one.
   *
   * A binding rather than a hook of this provider's own, and that is forced: this
   * provider is registered *after* `ViewServiceProvider`, so its `onRequest` sees
   * only what the static layer declined. For a file that exists — and a service
   * worker exists — the static layer answers first.
   */
  register(): void {
    const worker = this.config<string | false>('vite.serviceWorker', false)

    if (worker === false || worker === '') return

    const scope = this.config<string>('view.staticPrefix', '/')
    const path = `${this.prefix()}${worker.replace(/^\/+/, '')}`

    this.app.instance('assets.headers', (request: Request) => {
      if (new URL(request.url).pathname !== path) return {}

      return {
        /**
         * The one header only a server can send, and without it the worker is
         * refused outright.
         *
         * A service worker may claim no more than the directory it is served from,
         * and this one is served from the build directory — so a worker at
         * `/build/sw.js` controls `/build/` and nothing else, which is every URL a
         * client-routed application does not use. Measured in Chromium:
         * *"The path of the provided scope ('/') is not under the max scope allowed
         * ('/build/'). Adjust the scope, move the Service Worker script, or use the
         * Service-Worker-Allowed HTTP header to allow the scope."* Of those three,
         * this is the only one that leaves the build output where the build put it.
         */
        'service-worker-allowed': scope,

        /**
         * And the one header that keeps the *next* worker reachable.
         *
         * `sw.js` carries no content hash, so nothing about its name changes when
         * it does. A browser checking for an update honours the cache directive it
         * was given, which is how an application freezes at its first deployed
         * worker: measured before `vite.assetsDirectory` narrowed the immutable
         * prefix, this file went out `max-age=31536000, immutable`. `no-cache`
         * means revalidate, not "do not store".
         */
        'cache-control': 'no-cache'
      }
    })
  }

  /** `/build/`, from the two keys that decide it. */
  private prefix(): string {
    const mount = this.config<string>('view.staticPrefix', '/')
    const directory = this.config<string>('vite.buildDirectory', 'build').replace(/^\/+|\/+$/g, '')

    return `${mount.endsWith('/') ? mount : `${mount}/`}${directory}/`
  }

  override boot(): void {
    if (this.config<boolean>('vite.guardBuildDirectory', true) === false) return

    const directory = this.config<string>('vite.buildDirectory', 'build').replace(/^\/+|\/+$/g, '')

    const root = this.config<string>('view.publicPath', this.app.publicPath())

    /**
     * An `onRequest` hook, not a route, and that is the whole difficulty.
     *
     * A route registered here loses: providers boot before routes files load, and
     * a wildcard declared later wins — measured, `/build/assets/index-abc123.js`
     * answered `200` from the view route with this mounted as a route ahead of it.
     * `onRequest` runs before routing altogether, and returning a `Response` from
     * it answers outright.
     *
     * Which means it has to be careful about the files that *are* there: it stats
     * the path and hands anything it finds back untouched, exactly as
     * `@elvel/view`'s compression hook does for the same directory.
     */
    this.use(
      new Elysia({ name: 'elvel:vite-build-guard' }).onRequest(async ({ request }) => {
        const { pathname } = new URL(request.url)

        /**
         * `pathname` is already normalised, which is why there is no traversal
         * check here — one would be dead code implying protection it does not give.
         * Measured: `/build/../.env` arrives as `/.env`, so it never matches this
         * prefix at all and is somebody else's question.
         */
        if (!pathname.startsWith(`/${directory}/`)) return

        if (await Bun.file(join(root, decodeURIComponent(pathname))).exists()) return

        throw new NotFoundException('No such file.')
      })
    )
  }
}
