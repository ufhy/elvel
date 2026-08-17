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
    name: 'elyvel:hot-file',
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
 * Exported as a plain object rather than through `defineConfig`.
 *
 * Vite accepts either, and this way the file needs no import from `vite` — so
 * `bun run typecheck` works in a checkout that has not installed the front-end
 * dependencies yet, which is every checkout until somebody runs the build.
 */
export default {
  plugins: [hotFile()],

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
