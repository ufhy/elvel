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
  /** Nothing to bind: this provider only mounts a plugin. */
  register(): void {
    //
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
