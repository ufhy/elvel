import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** What Vite hands `config`. Typed here so the package needs no import from vite. */
type ConfigEnv = { command: string; isSsrBuild?: boolean }

type UserConfig = {
  base?: string
  root?: string
  publicDir?: string | false
  build?: {
    outDir?: string
    emptyOutDir?: boolean
    manifest?: boolean | string
    copyPublicDir?: boolean
    rollupOptions?: { input?: unknown }
  }
}

/** What this plugin answers with — a partial Vite config, and only these keys. */
type Answer = {
  base?: string
  publicDir?: false
  build: {
    outDir: string
    emptyOutDir: boolean
    manifest: string | boolean
    copyPublicDir?: boolean
    rollupOptions: { input?: unknown }
  }
  server?: { watch: { ignored: string[] } }
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
  transformIndexHtml(url: string, html: string): Promise<string>
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
   * Where an SSR build writes, relative to the application.
   *
   * **Not** inside `public/`, which is the whole point. Left to the client
   * defaults, `vite build --ssr` wrote the server bundle to
   * `public/build/entry-server.js` — downloadable at `/build/entry-server.js` —
   * and overwrote the client manifest with one naming only the server entry, so
   * every page then threw `is not in the Vite manifest`. Measured on the `vue-ts`
   * template.
   *
   * `bootstrap/ssr` is Laravel's location for the same output.
   */
  ssrDirectory?: string

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
  let tagsFile = ''
  let indexHtml = ''
  let outputDir = ''
  let manifestName: string | boolean = 'manifest.json'

  return {
    name: 'elvel',

    /**
     * Answers to the questions an application should not have to think about.
     *
     * Every value defers to one the application set itself, which is what makes
     * this a default rather than a decision taken away.
     */
    config(user: UserConfig, { command, isSsrBuild }: ConfigEnv): Answer {
      root = applicationRoot(options.appDirectory ?? process.cwd())
      hotFile = join(root, 'public', 'hot')
      tagsFile = join(root, 'public', 'hot-tags.txt')

      /**
       * Vite's own root and public directory, as Vite would resolve them.
       *
       * `root` defaults to the working directory — which is the project Vite was
       * started in — and `publicDir` to `public` inside it.
       */
      const viteRoot = resolve(user.root ?? options.appDirectory ?? process.cwd())
      const outDir = user.build?.outDir ?? join(root, 'public', build)

      outputDir = outDir
      manifestName = user.build?.manifest ?? 'manifest.json'

      const publicDir =
        user.publicDir === false ? false : resolve(viteRoot, user.publicDir ?? 'public')

      /**
       * The project's own `index.html`, built and then thrown away.
       *
       * A Vite plugin injects into the page through `transformIndexHtml`, and at
       * build time that hook only runs for an HTML input. A backend-integrated
       * application serves no `index.html`, so `vite-plugin-pwa` — the one plugin
       * of the three that injects during a build — lost both of its tags:
       * `<link rel="manifest">` and its `registerSW.js` script.
       *
       * So the file is built for its side effect. Every official template ships
       * one, its tags are harvested in `generateBundle`, and the HTML itself is
       * dropped from the output before it can be published: the server renders its
       * own document, and two of them would be one too many.
       */
      indexHtml = command === 'build' ? join(viteRoot, 'index.html') : ''

      const entryInputs =
        indexHtml !== '' && existsSync(indexHtml)
          ? [...(Array.isArray(options.input) ? options.input : [options.input]), indexHtml]
          : options.input

      const swallowsOutput =
        publicDir !== false &&
        (resolve(outDir) === publicDir || resolve(outDir).startsWith(publicDir + sep))

      /**
       * An SSR build is a different build, and answering it like the client one is
       * how a server bundle ends up on the web.
       *
       * No manifest — the client's is the one the server reads, and writing this
       * build's over it leaves every page unable to find its own script. No
       * `base`, because nothing here is fetched by a browser. And a directory
       * outside `public/`, because everything in there is served.
       */
      if (isSsrBuild === true) {
        /**
         * `publicDir` is left alone here, and the reason is worth writing down.
         *
         * Turning it off looked harmless — a server bundle has no use for copied
         * assets — and broke the build: `publicDir` is also how Vite *resolves* a
         * `/icons.svg` written in source, so the `vue-ts` template failed with
         * `Could not resolve '/icons.svg'`.
         *
         * `copyPublicDir` is the knob that was actually wanted: resolution stays,
         * the copy stops. Without it the assets were duplicated into the SSR
         * output, where nothing serves them.
         */
        return {
          build: {
            outDir: user.build?.outDir ?? join(root, options.ssrDirectory ?? 'bootstrap/ssr'),
            emptyOutDir: user.build?.emptyOutDir ?? true,
            manifest: user.build?.manifest ?? false,
            copyPublicDir: user.build?.copyPublicDir ?? false,
            rollupOptions: user.build?.rollupOptions ?? {}
          }
        }
      }

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
         * Turned off only when it would swallow its own output.
         *
         * In the scaffold, Vite's root *is* the application, so `publicDir` is
         * `public/` and the build writes to `public/build` — inside it. The copy
         * step would then walk the directory it is writing into, and Vite says so:
         * "The public directory feature may not work correctly." There is also
         * nothing to copy, because that directory is the document root already.
         *
         * A client project of its own is the opposite case, and getting this wrong
         * broke every official Vite template. `frontend/public/` is that project's
         * own asset directory and has nothing to do with the application's — so
         * disabling it dropped `favicon.svg` and `icons.svg` from the build output
         * of all nine presets, silently, and made `vue-ts` fail outright: its
         * `HelloWorld.vue` imports `/icons.svg`, and with no public directory there
         * is nothing for that path to resolve to.
         *
         * So the question is not which layout this is, it is whether the output
         * lands inside the input.
         */
        ...(swallowsOutput ? { publicDir: false as const } : {}),

        build: {
          outDir,
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
          manifest: manifestName,
          rollupOptions: {
            ...user.build?.rollupOptions,
            input: user.build?.rollupOptions?.input ?? entryInputs
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

    /**
     * Take what the plugins injected, then remove the page they injected into.
     *
     * `writeBundle`, not `generateBundle`: Vite's own HTML plugin transforms the
     * page during `generateBundle`, so a hook there sees it before the injections
     * exist — measured, it saw nothing at all. By `writeBundle` every plugin has
     * had its turn, which also means the file is on disk, so removing it is a
     * delete rather than a `delete`.
     */
    writeBundle(_options: unknown, bundle: Record<string, { source?: string | Uint8Array }>) {
      if (indexHtml === '' || !existsSync(indexHtml)) return

      const key = Object.keys(bundle).find((name) => name.endsWith('index.html'))

      if (key === undefined) return

      const asset = bundle[key]
      const built = typeof asset?.source === 'string' ? asset.source : ''

      /**
       * The page itself is not published, because the server renders its own.
       *
       * Two documents in one application is one too many: the stale one answers
       * whatever asks for `/build/index.html`, and what it contains is a copy of
       * the shell from whenever the last build ran.
       */
      rmSync(join(outputDir, key), { force: true })

      const tags = injectedTags(built, readFileSync(indexHtml, 'utf8'))

      if (tags === '') {
        rmSync(join(outputDir, 'injected-tags.txt'), { force: true })

        return
      }

      mkdirSync(outputDir, { recursive: true })
      writeFileSync(join(outputDir, 'injected-tags.txt'), tags)
    },

    /**
     * And the manifest forgets the page that was only built to be read.
     *
     * The extra input leaves an `index.html` key in `manifest.json`, naming a file
     * this plugin has just deleted. Nothing the framework does looks it up, and
     * that is exactly why it should not be there: a manifest entry pointing at a
     * file nobody wrote is a puzzle for whoever finds it next.
     */
    closeBundle() {
      if (indexHtml === '' || outputDir === '') return

      const path = join(outputDir, typeof manifestName === 'string' ? manifestName : '')

      if (manifestName === false || !existsSync(path)) return

      try {
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

        for (const key of Object.keys(manifest)) {
          if (key.endsWith('index.html')) delete manifest[key]
        }

        writeFileSync(
          path,
          `${JSON.stringify(manifest, null, 2)}
`
        )
      } catch {
        // A manifest this cannot parse is not one to rewrite.
      }
    },

    configureServer(server: DevServer) {
      writeHotFile(server, hotFile, tagsFile)

      if (options.refresh === false) return

      watchServerFiles(server, root, options.refresh ?? REFRESH)
    }
  }
}

/**
 * What a plugin added to the page, told apart from what the page already had.
 *
 * Comparing whole strings does not work: a build rewrites URLs, so the template's
 * own `favicon.svg` link comes back different from the one on disk. What survives
 * a rewrite is what the tag *is* — its name, and its `rel`, `id` or `type`. A tag
 * whose identity the source already had was not injected.
 *
 * Stylesheets are the one explicit exception. Vite adds them for an HTML entry and
 * the source has none, so they read as injected — but the view renders them from
 * the manifest, and a second copy is a second request for the same bytes.
 */
export function injectedTags(built: string, source: string): string {
  /**
   * A fresh pattern per scan, because a global regex carries `lastIndex`.
   *
   * One shared literal, two `matchAll` calls: the second started where the first
   * had stopped and found nothing. It cost an empty harvest against a page with
   * two obvious injections in it, and it reads perfectly.
   *
   * Two branches, because a script has a body and a link does not. A single
   * pattern with an optional closing tail read fine and was also wrong: for a
   * `<link>`, that tail matched forward to the *next* script's closing tag, so one
   * "tag" swallowed half the document.
   *
   * `<\/script\s*>` rather than `<\/script>`: HTML allows whitespace before the
   * closing angle bracket. Vite never emits it, so nothing was broken — but a
   * harvester that silently stops matching when its input gains a space is one
   * whose failure arrives as a missing stylesheet nobody can explain.
   */
  const tagsIn = (html: string): string[] =>
    [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi)].map(
      (match) => match[0]
    )

  const identify = (tag: string): string => {
    const name = /^<(\w+)/.exec(tag)?.[1]?.toLowerCase() ?? ''
    const rel = /rel="([^"]+)"/.exec(tag)?.[1]
    const id = /id="([^"]+)"/.exec(tag)?.[1]

    return `${name}:${rel ?? id ?? (/src=/.test(tag) ? 'src' : 'inline')}`
  }

  const known = new Set(tagsIn(source).map(identify))

  return tagsIn(built)
    .filter((tag) => {
      const kind = identify(tag)

      /**
       * What Vite itself adds for an HTML entry is not an injection.
       *
       * A stylesheet and a `modulepreload` both name the very chunk the view
       * already renders from the manifest — so keeping them means a second request
       * for the same bytes, and a preload hint for a script that is already on the
       * page. The source has neither, so nothing else tells them apart.
       */
      if (kind === 'link:stylesheet' || kind === 'link:modulepreload') return false

      return !known.has(kind)
    })
    .join('')
}

/**
 * The hot file, which is how the server knows a dev server is running.
 *
 * `vite()` in a view renders tags pointing at this server while it is up, and tags
 * from the manifest when it is not. The file's *presence* is the signal and its
 * contents are the origin to point at — so it has to be removed when the server
 * stops, or a production render sends the browser to a machine that is not there.
 */
function writeHotFile(server: DevServer, path: string, tagsPath: string): void {
  const clean = () => {
    rmSync(path, { force: true })
    rmSync(tagsPath, { force: true })
  }

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

    void publishInjectedTags(server, tagsPath)
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
 * What the other plugins want in the document, written where the server can read it.
 *
 * A Vite plugin injects into the page through `transformIndexHtml`, and that hook
 * needs an `index.html` to transform. An application whose document the server
 * renders has none, so those injections were simply lost — measured against the
 * official templates:
 *
 * | plugin | what was missing | what broke |
 * | --- | --- | --- |
 * | `@vitejs/plugin-react` | the `/@react-refresh` preamble | Fast Refresh |
 * | `vite-plugin-vue-devtools` | `overlay.js`, `load.js` | DevTools never loaded |
 *
 * Nothing here knows about either of them. The plugin runs *inside* Vite, so it
 * asks Vite the same question the hook answers — against a marked-up blank
 * document — and writes whatever came back beside the hot file. `vite()` in a view
 * emits it. A plugin nobody has written yet arrives the same way.
 *
 * Asked once, for `/`. A plugin that injects differently per URL exists in theory;
 * the ones that do this in practice inject the same thing on every page, and a
 * file written once is what a sibling process can read without asking.
 */
async function publishInjectedTags(server: DevServer, path: string): Promise<void> {
  /**
   * An empty head and an empty body, so whatever is inside them afterwards is the
   * answer.
   *
   * The first attempt put markers in and read what followed them, which found
   * nothing: Vite injects with `head-prepend` as often as `head`, so half the tags
   * landed *before* the marker. Measured against `react-ts`, whose Fast Refresh
   * preamble is prepended. An empty container needs no marker and cannot be
   * outflanked by either.
   */
  try {
    const transformed = await server.transformIndexHtml(
      '/',
      '<!doctype html><html><head></head><body></body></html>'
    )

    const between = (open: string, close: string): string => {
      const from = transformed.indexOf(open)
      const to = transformed.indexOf(close)

      return from < 0 || to < from ? '' : transformed.slice(from + open.length, to)
    }

    const injected = between('<head>', '</head>') + between('<body>', '</body>')

    /**
     * `@vite/client` is dropped, because the view already renders it.
     *
     * It has to be first in the document — it opens the socket everything else
     * reports over — so it is the view's to place, not something to append twice.
     */
    const tags = injected
      .replaceAll(/<script[^>]*src="[^"]*@vite\/client"[^>]*><\/script>/g, '')
      .trim()

    if (tags === '') {
      rmSync(path, { force: true })

      return
    }

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, tags)
  } catch {
    /**
     * A transform that throws leaves no file, and that is the whole handling.
     *
     * This is a convenience for development. Failing here must not stop a dev
     * server from starting — the page still works, minus whatever a plugin wanted
     * to add to it.
     */
    rmSync(path, { force: true })
  }
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
