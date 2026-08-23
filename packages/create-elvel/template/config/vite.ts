export default {
  /**
   * Where the client project lives, relative to the application root.
   *
   * `.` is the scaffold: `vite.config.ts` sits beside `elvel.ts` and the client
   * source is in `resources/`. Read by `elvel dev`, which runs Vite here — so a
   * front end that is its own project (`bun create vite` in `frontend/`, with its
   * own config and `node_modules`) names that directory instead:
   *
   * ```ts
   * projectDirectory: 'frontend'
   * ```
   *
   * Pointed at the wrong place, Vite still starts and still takes a port — it
   * simply answers 404 for everything and writes no hot file, so the server falls
   * back to the last build and `dev` looks like it worked. That is the failure
   * this key exists to prevent.
   */
  projectDirectory: '.',

  /**
   * Where the build writes, inside `public/`.
   *
   * Read by the `vite()` helper to find `manifest.json` and to build the URLs
   * in the tags it renders. Change it here and in `vite.config.ts` together —
   * they are two halves of one decision.
   */
  buildDirectory: 'build'
}
