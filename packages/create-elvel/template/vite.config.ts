import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

      // Both, because a killed terminal fires one and a clean stop the other.
      process.on('exit', clean)
      process.on('SIGINT', () => process.exit())
    },

    closeBundle: clean
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
      server.watcher.add(watched)

      /**
       * `server.hot`, not `server.ws`.
       *
       * Vite 8 removed `server.ws`; `hot` is the channel for the client
       * environment and the one that survives the environment API.
       */
      const reload = (file: string) => {
        if (!watched.some((directory) => file.includes(directory.replace('./', '')))) return

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
export default {
  plugins: [
    hotFile(),
    /**
     * Everything that can change what the server renders. `bun --hot` reloads the
     * server for these; this is what tells the browser about it.
     */
    refresh(['./resources/views', './app', './routes', './config'])
  ],

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
}
