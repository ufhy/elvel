import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** What Vite hands `config`. Typed here so the package needs no import from vite. */
type ConfigEnv = { command: string }

type UserConfig = {
  base?: string
  publicDir?: string | false
  build?: {
    outDir?: string
    emptyOutDir?: boolean
    manifest?: boolean | string
    rollupOptions?: { input?: unknown }
  }
}

type DevServer = {
  httpServer?: {
    once(event: string, handler: () => void): unknown
    address(): { port?: number } | string | null
  } | null
  watcher: {
    add(paths: string[]): unknown
    on(event: string, handler: (file: string) => void): unknown
  }
  hot: { send(payload: { type: 'full-reload'; path: string }): void }
}

export type ElvelViteOptions = {
  /** Entry points, as Rollup input — `'src/main.ts'` or a list. */
  input: string | string[]

  /**
   * Where the build writes inside `public/`, and the prefix its URLs carry.
   *
   * Must match `buildDirectory` in the application's `config/vite.ts`: the server
   * reads the manifest from there, and this writes it there.
   */
  buildDirectory?: string

  /**
   * The application root, when it cannot be found by looking.
   *
   * Found by walking up from the Vite project until an `elvel.ts` appears, which
   * covers both layouts — a config beside `elvel.ts`, and a client project of its
   * own in `frontend/`. Set this when the application lives somewhere a walk
   * upwards will not reach it.
   */
  appDirectory?: string

  /**
   * Directories whose changes reload the browser, relative to the application.
   *
   * These are the files that decide what the *server* renders; `false` turns the
   * reload off. Client modules under the Vite project keep their own HMR either
   * way — this is only for the half of the page Vite never sees.
   */
  refresh?: string[] | false
}

/** Everything that produces HTML on the server. */
const REFRESH = ['resources/views', 'app', 'routes', 'config']

/**
 * The application root, found rather than configured.
 *
 * `elvel.ts` is the one file every application has at its root and no client
 * project has. Walking up for it is what lets the same plugin serve a config that
 * sits beside it and a `bun create vite` project in `frontend/` — the hot file and
 * the build output belong to the application in both cases, not to whichever
 * directory Vite was started in.
 */
export function applicationRoot(from: string): string {
  let directory = resolve(from)

  for (;;) {
    if (existsSync(join(directory, 'elvel.ts'))) return directory

    const parent = dirname(directory)

    if (parent === directory) return resolve(from)

    directory = parent
  }
}

/**
 * The Vite half of an Elvel application.
 *
 * ```ts
 * import elvel from '@elvel/vite'
 *
 * export default { plugins: [elvel({ input: 'src/main.ts' })] }
 * ```
 *
 * Five copies of this logic lived in this repository before it was a package — 94
 * to 214 lines each, all variants of the same thing — and the drift between them
 * is where the bugs were. `base` unset in one made a lazily imported chunk answer
 * 404 while the others were fine. `publicDir` left at its default printed a
 * warning in every scaffolded application. A hot file nobody removed pointed a
 * production render at a dev server that had stopped.
 *
 * `laravel-vite-plugin` exists for the same reason and settles the same questions.
 */
export default function elvel(options: ElvelViteOptions) {
  const build = options.buildDirectory ?? 'build'
  let root = ''
  let hotFile = ''

  return {
    name: 'elvel',

    /**
     * Answers to the questions an application should not have to think about.
     *
     * Every value defers to one the application set itself, which is what makes
     * this a default rather than a decision taken away.
     */
    config(user: UserConfig, { command }: ConfigEnv) {
      root = applicationRoot(options.appDirectory ?? process.cwd())
      hotFile = join(root, 'public', 'hot')

      return {
        /**
         * `base` is what Vite writes into the URLs it generates *itself*.
         *
         * Not the entry points — the server prefixes those when it reads the
         * manifest — but everything else: a dynamic `import()`, a chunk produced
         * by code splitting, an asset referenced from CSS. Left at its default the
         * first `import()` in an application resolves to `/assets/…` and answers
         * 404 while the file sits in `/build/assets/…`.
         *
         * It cannot simply be the build prefix always: in `serve`, `base` is also
         * the path the dev server itself answers under.
         */
        base: user.base ?? (command === 'build' ? `/${build}/` : ''),

        /**
         * Vite copies nothing; the application already serves `public/`.
         *
         * The build output lives *inside* the default `publicDir`, so the copy
         * step would walk the directory it is writing into — Vite says as much:
         * "The public directory feature may not work correctly." And there is
         * nothing to copy. `public/` is the document root: the server hands out
         * `favicon.svg` from where it already sits, and a second copy under the
         * build prefix is one nothing links to.
         */
        publicDir: user.publicDir ?? false,

        build: {
          outDir: user.build?.outDir ?? join(root, 'public', build),
          /**
           * Emptied, and said out loud.
           *
           * With a client project of its own the output is outside Vite's root,
           * where Vite refuses to empty a directory without being asked — and then
           * yesterday's chunks stay beside today's, in a manifest that no longer
           * names them.
           */
          emptyOutDir: user.build?.emptyOutDir ?? true,
          /**
           * Named, not merely enabled.
           *
           * Vite 5 moved the manifest to `.vite/manifest.json` inside the output
           * directory. Naming it puts it back where the server looks for it.
           */
          manifest: user.build?.manifest ?? 'manifest.json',
          rollupOptions: {
            ...user.build?.rollupOptions,
            input: user.build?.rollupOptions?.input ?? options.input
          }
        },

        /**
         * What the watcher must *not* watch.
         *
         * A running application writes inside the directory Vite is watching — a
         * session file per request, a SQLite database, the build output. Left
         * alone that is a loop that feeds itself: a write triggers a reload, the
         * reload is a request, the request writes a session file. Measured at six
         * reloads in ten idle seconds.
         */
        server: {
          watch: {
            ignored: ['**/storage/**', '**/database/**', `**/public/${build}/**`, '**/public/hot']
          }
        }
      }
    },

    configureServer(server: DevServer) {
      writeHotFile(server, hotFile)

      if (options.refresh === false) return

      watchServerFiles(server, root, options.refresh ?? REFRESH)
    }
  }
}

/**
 * The hot file, which is how the server knows a dev server is running.
 *
 * `vite()` in a view renders tags pointing at this server while it is up, and tags
 * from the manifest when it is not. The file's *presence* is the signal and its
 * contents are the origin to point at — so it has to be removed when the server
 * stops, or a production render sends the browser to a machine that is not there.
 */
function writeHotFile(server: DevServer, path: string): void {
  const clean = () => rmSync(path, { force: true })

  server.httpServer?.once('listening', () => {
    const address = server.httpServer?.address()
    const port = typeof address === 'object' && address?.port ? address.port : 5173

    /**
     * The directory first, because it does not have to exist.
     *
     * `public/` is there in a scaffolded application and not in a client project
     * that has never run a build — and `writeFileSync` does not create parents, so
     * this threw `ENOENT` and took the dev server down with it. Found by a test
     * against a temporary directory, which is the case nobody runs by hand.
     */
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `http://localhost:${port}`)
  })

  /**
   * Every stop this process can be asked to make politely.
   *
   * `exit` covers a normal end, and the two signals turn a request to stop into
   * one — a handler that only logged would leave the file behind. What none of
   * them covers is a *forced* kill: `taskkill /f`, Task Manager, a closed terminal
   * window. Measured on Windows, both `taskkill /t /f` and `taskkill /t` left the
   * file in place, which is why `elvel dev` removes a stale one when it starts and
   * why the framework ignores it in production.
   */
  process.on('exit', clean)
  process.on('SIGINT', () => process.exit())
  process.on('SIGTERM', () => process.exit())
}

/**
 * Reload the browser when something the *server* renders changes.
 *
 * Neither Bun nor Elysia can do this, and neither is in a position to: whatever
 * reloads the page has to hold a socket to the page. Bun holds the process — its
 * own documentation says `--hot` "is not the same as hot reloading in the browser".
 * Elysia holds the routes. Vite holds the only socket a browser is already
 * listening on, because the view renders `@vite/client` while this server is up.
 *
 * A **full reload**, not a hot update. A `.tsx` view is rendered to a string on
 * the server and the browser never receives a module for it, so there is nothing
 * to swap — fetching the page again is the honest answer, and what
 * `laravel-vite-plugin` does for Blade.
 */
function watchServerFiles(server: DevServer, root: string, watched: string[]): void {
  /**
   * Resolved once, and compared as a path prefix rather than a substring.
   *
   * `file.includes('app')` was the obvious spelling and the wrong one: it matches
   * any path with those three letters anywhere in it. An application in
   * `apps/demo` matched every file it owns and — worse — so did
   * `resources/css/app.css`, which turned a CSS hot update into a full page
   * reload. A prefix with a trailing slash can only match a real descendant.
   */
  const roots = watched.map((directory) => resolve(root, directory).replaceAll('\\', '/'))

  server.watcher.add(roots)

  /**
   * `server.hot`, not `server.ws`.
   *
   * Vite 8 removed `server.ws`; `hot` is the channel for the client environment
   * and the one that survives the environment API.
   */
  const reload = (file: string) => {
    const path = file.replaceAll('\\', '/')

    if (!roots.some((one) => path === one || path.startsWith(`${one}/`))) return

    server.hot.send({ type: 'full-reload', path: '*' })
  }

  server.watcher.on('change', reload)
  server.watcher.on('add', reload)
  server.watcher.on('unlink', reload)
}
