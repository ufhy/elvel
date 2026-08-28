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
  guardBuildDirectory: true
}
