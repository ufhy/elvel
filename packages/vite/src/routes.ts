import { config, NotFoundException } from '@elvel/core'
import { Route } from '@elvel/http'

/**
 * A miss under the build directory stays a miss — Laravel has nothing to do here,
 * because static files are not routes there at all.
 *
 * `@elvel/view` serves what is in `public/` with `alwaysStatic: true`, which means
 * the table holds only files that exist and anything else falls through to the
 * router. That is deliberate and it is right for the root: it is the shape of
 * nginx's `try_files $uri $uri/ /index.php`, and it is what lets a client-routed
 * application answer `/invoices/9`.
 *
 * Under the build directory it is wrong. Nothing lives there but output with a
 * content hash in its name, so a request for one that is gone is a stale document
 * asking for yesterday's bundle — and falling through hands it whatever the
 * application's catch-all renders. Measured: `/build/assets/index-abc123.js`
 * answered `200` and a page of HTML, so a browser waiting for JavaScript got
 * markup and the application failed with nothing saying why.
 *
 * ```ts
 * // routes/web.ts, or wherever the application's routes are collected
 * import { guardBuildDirectory } from '@elvel/vite/routes'
 *
 * guardBuildDirectory()
 * ```
 *
 * `vite.guardBuildDirectory: false` turns it off, for an application that would
 * rather answer those itself.
 *
 * **Imported by the server, not by Vite.** `@elvel/vite`'s default export is the
 * plugin and runs inside `vite.config.ts`, where none of this exists; this is a
 * separate entry point, and `@elvel/http` is an optional peer so that a client
 * project depending on the plugin does not install a server framework it never
 * loads.
 */
export function guardBuildDirectory(): void {
  if (config<boolean>('vite.guardBuildDirectory', true) === false) return

  const directory = config<string>('vite.buildDirectory', 'build').replace(/^\/+|\/+$/g, '')

  /**
   * Every verb, and a wildcard.
   *
   * A `POST` to a missing asset is still not a page, and the `.*` is what makes
   * this cover `assets/index-abc123.js` rather than only a single segment.
   */
  Route.any(`/${directory}/{path}`, () => {
    throw new NotFoundException('No such file.')
  }).where('path', '.*')
}
