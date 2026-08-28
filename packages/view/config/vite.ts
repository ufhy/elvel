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
  buildDirectory: 'build',

  /**
   * Where inside the build the *hashed* names live — Vite's `build.assetsDir`.
   *
   * Only this directory is cached for a year and served `immutable`, because only
   * here does a filename carry a content hash and therefore cannot go stale. What
   * sits at the build root does not: `manifest.json` keeps its name when its
   * contents change, and so do the files a plugin emits there — `sw.js`,
   * `registerSW.js`, `manifest.webmanifest`.
   *
   * Measured before this key existed, with the whole build directory treated as
   * hashed: a service worker went out `max-age=31536000, immutable` under a name
   * with no hash in it, so a browser had no reason to fetch the next one for a
   * year. An application would have frozen at its first deployed worker with
   * nothing failing anywhere.
   *
   * Change it here and in `vite.config.ts` together — two halves of one decision,
   * as `buildDirectory` is.
   */
  assetsDirectory: 'assets',
  /**
   * The service worker to let claim the whole site — a filename, or `false`.
   *
   * A worker may control no more than the directory it is served from, and Vite
   * writes it into the build directory. So `sw.js` there controls `/build/` and
   * nothing else, which is every address a client-routed application does not use.
   * Naming it here sends `Service-Worker-Allowed` for that one file, which is the
   * only remedy that leaves the build output where the build put it — the other two
   * a browser offers are to give up the scope or to move the file out of the build.
   *
   * It also sends `cache-control: no-cache` for it. `sw.js` carries no content hash,
   * so nothing about its name changes when it does, and a worker cached for a year
   * is an application frozen at whichever worker it deployed first.
   *
   * `false` unless you are building one: a header naming a scope should not be sent
   * for a file that is not there.
   *
   * ```ts
   * // frontend/vite.config.ts — and this is the whole of it
   * VitePWA({ scope: '/', manifest: { name: 'My app', start_url: '/' } })
   * ```
   */
  serviceWorker: false as string | false
}
