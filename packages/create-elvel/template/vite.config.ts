import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The hot file, which is how the framework knows a dev server is running.
 *
 * `vite()` in a layout renders tags pointing at this server while it is up, and
 * tags from `public/build/manifest.json` when it is not. The file's *presence*
 * is the whole signal, and its contents are the origin to point at — so it has
 * to be removed when the server stops, or a production render would send the
 * browser to a machine that is not there.
 *
 * Laravel's `laravel-vite-plugin` does exactly this; it is a few lines, so this
 * template does it rather than taking a dependency.
 */
function hotFile() {
  const path = join(import.meta.dirname, 'public', 'hot')
  const clean = () => rmSync(path, { force: true })

  return {
    name: 'elvel:hot-file',
    apply: 'serve',

    configureServer(server: {
      httpServer?: {
        once(event: string, handler: () => void): unknown
        address(): { port?: number } | string | null
      } | null
    }) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        const port = typeof address === 'object' && address?.port ? address.port : 5173

        writeFileSync(path, `http://localhost:${port}`)
      })

      /**
       * Every stop this process can be asked to make politely.
       *
       * `exit` covers a normal end, and the two signals turn a request to stop
       * into one — a handler that only logs would leave the file behind. What
       * none of them covers is a *forced* kill: `taskkill /f`, Task Manager, a
       * closed terminal window. Measured on Windows, both `taskkill /t /f` and
       * `taskkill /t` left the file in place, which is why `elvel dev` removes a
       * stale one when it starts and why the framework ignores it in production.
       */
      process.on('exit', clean)
      process.on('SIGINT', () => process.exit())
      process.on('SIGTERM', () => process.exit())
    }
  }
}

/**
 * Reload the browser when something the *server* renders changes.
 *
 * Neither Bun nor Elysia can do this, and neither is in a position to: whatever
 * reloads the page has to hold a socket to the page. Bun holds the process —
 * `--hot` re-evaluates modules in place, and its own documentation says outright
 * that it "is not the same as hot reloading in the browser". Elysia holds the
 * routes. Vite holds the only socket a browser is already listening on, because
 * `vite()` in the layout renders `@vite/client` while this server is up.
 *
 * So: watch the files that produce HTML, and push a full reload down that socket.
 * `laravel-vite-plugin` does exactly this for Blade, for the same reason.
 *
 * A **full reload**, not a hot update. A `.tsx` view here is rendered to a string
 * on the server and the browser never receives a module for it, so there is
 * nothing to swap — the honest thing is to fetch the page again. `resources/js`
 * and `resources/css` are real client modules and keep their proper HMR.
 */
function refresh(watched: string[]) {
  return {
    name: 'elvel:refresh',
    apply: 'serve',

    configureServer(server: {
      watcher: {
        add(paths: string[]): unknown
        on(event: string, handler: (file: string) => void): unknown
      }
      hot: { send(payload: { type: 'full-reload'; path: string }): void }
    }) {
      /**
       * Resolved once, and compared as a path prefix rather than a substring.
       *
       * `file.includes('app')` was the obvious spelling and the wrong one: it
       * matches any path with those three letters anywhere in it. An application
       * in `apps/demo` matched every file it owns, and — worse — so did
       * `resources/css/app.css`, which turned a CSS hot update into a full page
       * reload. A prefix with a trailing slash can only match a real descendant.
       */
      const roots = watched.map((directory) =>
        resolve(import.meta.dirname, directory).replaceAll('\\', '/')
      )

      server.watcher.add(watched)

      /**
       * `server.hot`, not `server.ws`.
       *
       * Vite 8 removed `server.ws`; `hot` is the channel for the client
       * environment and the one that survives the environment API.
       */
      const reload = (file: string) => {
        if (!roots.some((root) => file === root || file.startsWith(`${root}/`))) return

        server.hot.send({ type: 'full-reload', path: '*' })
      }

      server.watcher.on('change', reload)
      server.watcher.on('add', reload)
      server.watcher.on('unlink', reload)
    }
  }
}

/**
 * Exported as a plain object rather than through `defineConfig`.
 *
 * Vite accepts either, and this way the file needs no import from `vite` — so
 * `bun run typecheck` works in a checkout that has not installed the front-end
 * dependencies yet, which is every checkout until somebody runs the build.
 */
/**
 * The config is a function because one value depends on which command is running.
 *
 * `base` is what Vite writes into the URLs it generates *itself* — the ones no
 * template touches: a dynamic `import()`, a chunk pulled in by code splitting, an
 * asset referenced from CSS. `vite()` in a layout prefixes `/build/` by hand when
 * it reads the manifest, which covers the entry points and nothing else, so with
 * `base` left at its default the first `import()` in an application resolves to
 * `/assets/...` and answers 404 while the file sits in `/build/assets/...`.
 *
 * It cannot simply be `/build/` always: in `serve`, `base` is also the prefix the
 * dev server itself listens under, and the hot-file tags point straight at
 * `http://localhost:5173/resources/...`. `laravel-vite-plugin` resolves it the
 * same way — `command === 'build' ? assetUrl + '/build/' : ''`.
 */
export default ({ command }: { command: string }) => ({
  base: command === 'build' ? '/build/' : '',

  plugins: [
    hotFile(),
    /**
     * Everything that can change what the server renders. `bun --hot` reloads the
     * server for these; this is what tells the browser about it.
     */
    refresh(['./resources/views', './app', './routes', './config'])
  ],

  /**
   * What the watcher must *not* watch.
   *
   * Vite watches the project root, and a running application writes inside it —
   * a session file per request, a SQLite database, the build output. Left alone
   * that is a loop that feeds itself: a write triggers a reload, the reload is a
   * request, the request writes a session file, and the page reloads about once
   * a second forever. Measured here at six reloads in ten idle seconds.
   */
  server: {
    watch: {
      ignored: ['**/storage/**', '**/database/**', '**/public/build/**', '**/public/hot']
    }
  },

  build: {
    // `public/build`, which is what `config/vite.ts` names and what the
    // framework looks in for the manifest.
    outDir: 'public/build',
    emptyOutDir: true,
    /**
     * Named, not merely enabled.
     *
     * Vite 5 moved the manifest to `.vite/manifest.json` inside the output
     * directory. Naming it puts it back at `build/manifest.json`, which is where
     * the framework looks — and where Laravel's plugin keeps it too.
     */
    manifest: 'manifest.json',

    rollupOptions: {
      input: ['resources/css/app.css', 'resources/js/app.ts']
    }
  }
})
