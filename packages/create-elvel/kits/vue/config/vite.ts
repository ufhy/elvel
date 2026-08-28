export default {
  /**
   * The client is its own project, so Vite runs in there.
   *
   * `elvel dev` reads this to know where to start it, and `@elvel/vite` finds the
   * application from inside that directory by walking up for `elvel.ts` — which is
   * how the hot file and the build output land here rather than in `frontend/`.
   */
  projectDirectory: 'frontend',

  /**
   * Where the build writes, inside `public/`.
   *
   * Read by the `vite()` helper to find `manifest.json` and to build the URLs in
   * the tags it renders.
   */
  buildDirectory: 'build',

  /**
   * Where inside the build the *hashed* names live — Vite's `build.assetsDir`.
   *
   * Only this directory is served `immutable` for a year, because only here does a
   * filename carry a content hash. What a plugin emits at the build root does not:
   * `sw.js` and `registerSW.js` keep their names when their contents change, and a
   * service worker cached for a year is an application frozen at its first deployed
   * worker.
   */
  assetsDirectory: 'assets',

  /**
   * Whether a miss under `buildDirectory` is a 404 rather than a page.
   *
   * `guardBuildDirectory()` in `routes/view.ts` reads this. Static files fall
   * through to the router when they are not there, which is what lets a
   * client-routed application answer an address the server has no route for — and
   * under the build directory it means a cached document asking for a bundle that
   * has been rebuilt gets whatever the catch-all renders. Measured: `200` and a
   * page of HTML to a browser waiting for JavaScript.
   *
   * `false` for an application that would rather answer those addresses itself.
   */
  guardBuildDirectory: true,

  /**
   * `'sw.js'` turns this application into an installable one — and that is all.
   *
   * The client half is one option: `VitePWA({ scope: '/', … })` in
   * `frontend/vite.config.ts`. This key is the server half, and it exists because a
   * service worker may claim no more than the directory it is served from: Vite
   * writes it into `build/`, so without the header this sends it controls `/build/`
   * and none of the addresses the Vue router owns.
   *
   * `false` here, because a header naming a scope should not be sent for a file that
   * is not there. See `basics/frontend` for what the client half has to decide —
   * chiefly that `/api` is never cached.
   */
  serviceWorker: false as string | false
}
