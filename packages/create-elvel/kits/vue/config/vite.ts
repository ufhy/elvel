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
  buildDirectory: 'build'
}
