import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

type ManifestChunk = {
  file: string
  css?: string[]
  integrity?: string
}

/**
 * Tags for a Vite build — Laravel's `@vite` directive.
 *
 * Two modes, and the reason there are two is the whole feature:
 *
 * - **Development**: Vite's dev server is running and writes a *hot file*. The
 *   tags point at that server, so a change to a stylesheet reaches the browser
 *   without a rebuild or a reload.
 * - **Production**: there is no dev server, and the tags come from
 *   `manifest.json`, which maps `resources/js/app.ts` to the hashed file the
 *   build produced.
 *
 * The hashing is what earns this its place. Without a manifest an application
 * either serves `app.js` for ever — and a deploy silently ships stale
 * JavaScript to anybody with a warm cache — or defeats caching entirely with a
 * query string that changes every request.
 */
export class Vite {
  /** Warned once per process, not once per render. */
  private static warned = false

  /** The same, for a hot file that survived into production. */
  private static warnedHot = false

  constructor(
    private readonly options: {
      /** Where the build wrote its output, relative to the public directory. */
      buildDirectory?: string
      publicPath: string
      /** Written by `vite dev`; its presence is what "development" means. */
      hotFile?: string
      /**
       * Whether that presence may be believed.
       *
       * The file is written when the dev server binds and removed when it stops
       * — but only if it gets to run its handlers. A forced kill (`taskkill /f`,
       * Task Manager, a closed terminal) skips them, and the file survives.
       * Measured on Windows: both `taskkill /t /f` and `taskkill /t` left it
       * behind.
       *
       * A leftover file is a nuisance in development and a broken deploy in
       * production: every page points its scripts at `localhost:5173`, a machine
       * that is not there, so the application ships without assets and answers
       * 200 while doing it. So production does not believe it.
       */
      trustHotFile?: boolean
      /**
       * What to do when there is neither a dev server nor a build.
       *
       * A departure from Laravel, which throws
       * `ViteManifestNotFoundException` in every environment.
       *
       * `throw` here too in production, where a missing build means a deploy
       * shipped an unstyled page and silence would be the wrong answer. `ignore`
       * elsewhere, because `laravel new` runs the asset build as part of
       * installing — so Laravel's first boot always has a manifest — and this
       * scaffolder cannot: Bun installs the front-end packages only when the
       * developer asks. A 500 on the landing page before anybody has run
       * anything is a poor first minute; one warning naming the fix says the
       * same thing without breaking the page.
       */
      whenMissing?: 'throw' | 'ignore'
    }
  ) {}

  /** Is a dev server running — and are we willing to believe it? */
  get hot(): boolean {
    const present = existsSync(this.hotFilePath)

    if (present && this.options.trustHotFile === false) {
      if (!Vite.warnedHot) {
        Vite.warnedHot = true
        console.warn(
          `Ignoring ${this.hotFilePath} in production: it points at a dev server. ` +
            'Delete it — it is written by `vite dev` and should never be deployed.'
        )
      }

      return false
    }

    return present
  }

  /**
   * The `<script>` and `<link>` tags for these entry points.
   *
   * Returned as markup rather than a component, so it drops into a layout's
   * `<head>` exactly where it is needed and needs nothing imported alongside it.
   */
  tags(entrypoints: string | string[]): string {
    const entries = Array.isArray(entrypoints) ? entrypoints : [entrypoints]

    if (this.hot) {
      const origin = readFileSync(this.hotFilePath, 'utf8').trim().replace(/\/$/, '')

      // The client comes first and is not optional: it is what opens the socket
      // the dev server pushes updates over.
      const client = this.tagFor(`${origin}/@vite/client`, '@vite/client')
      const app = entries.map((entry) => this.tagFor(`${origin}/${entry}`, entry)).join('')

      /**
       * Between the two: whatever the other Vite plugins wanted in the document.
       *
       * A plugin injects through `transformIndexHtml`, which needs an `index.html`
       * to transform — and a document rendered by the server is not one. Measured
       * against the official Vite templates, that silently dropped the
       * `@vitejs/plugin-react` Fast Refresh preamble and the whole of Vue DevTools.
       *
       * `@elvel/vite` asks Vite for them when the dev server starts and writes them
       * beside the hot file. Nothing here knows what any of them are.
       *
       * The position is the requirement. React's preamble installs a global hook
       * that its components register against as they evaluate, so it has to run
       * before the entry — after it, Fast Refresh is quietly a full reload.
       */
      return [client, this.injected(), app].join('')
    }

    const manifest = this.manifest()

    // Nothing built and nothing running: the page renders without its assets.
    if (!manifest) return ''

    const tags: string[] = []

    for (const entry of entries) {
      const chunk = manifest[entry]

      if (!chunk) {
        // Naming the entry and the manifest: the usual cause is a build that has
        // not run, and "undefined is not a chunk" says none of that.
        throw new Error(
          `[${entry}] is not in the Vite manifest at ${this.manifestPath}. Has the build run?`
        )
      }

      // Stylesheets first, so the page does not paint unstyled while the
      // module graph loads.
      for (const stylesheet of chunk.css ?? []) {
        tags.push(this.tagFor(this.asset(stylesheet), stylesheet))
      }

      tags.push(this.tagFor(this.asset(chunk.file), chunk.file, chunk.integrity))
    }

    /**
     * And whatever the plugins added, after the entry rather than before it.
     *
     * Nothing harvested from a build has to run first: a service worker registers
     * on `load`, and a manifest link is not code. The dev counterpart is the
     * opposite case — React's preamble has to precede the entry — which is why
     * these two are not one call.
     */
    tags.push(this.injectedFromBuild())

    return tags.join('')
  }

  /**
   * The tags the dev server's other plugins asked for, if any.
   *
   * Read per render rather than cached: a plugin can be added to `vite.config.ts`
   * while the dev server is running, and the file is rewritten when it restarts.
   * One read of a small file in development, against a page that is being rendered
   * anyway.
   */
  private injected(): string {
    return this.readTags(join(dirname(this.hotFilePath), 'hot-tags.html'))
  }

  /**
   * The same question for a build: what did the plugins put in the page?
   *
   * `@elvel/vite` harvests them from the project's `index.html` while building and
   * writes them beside the manifest. `vite-plugin-pwa` is the plugin this exists
   * for — its `<link rel="manifest">` and `registerSW.js` are injected at build
   * time, where there is no dev server to ask.
   */
  private injectedFromBuild(): string {
    return this.readTags(join(dirname(this.manifestPath), 'injected.html'))
  }

  private readTags(path: string): string {
    if (!existsSync(path)) return ''

    return readFileSync(path, 'utf8').trim()
  }

  /** The public URL of a built file, by its manifest key. */
  asset(file: string): string {
    return `/${[this.options.buildDirectory ?? 'build', file].join('/').replace(/^\/+/, '')}`
  }

  private tagFor(url: string, name: string, integrity?: string): string {
    const attributes = integrity ? ` integrity="${integrity}"` : ''

    return name.endsWith('.css')
      ? `<link rel="stylesheet" href="${url}"${attributes}>`
      : `<script type="module" src="${url}"${attributes}></script>`
  }

  private get hotFilePath(): string {
    return this.options.hotFile ?? join(this.options.publicPath, 'hot')
  }

  /**
   * Where the manifest is, allowing for both places Vite has put it.
   *
   * `build/manifest.json` is where a config that names the file writes it, and
   * the only place Laravel looks — `laravel-vite-plugin` sets `manifest:
   * 'manifest.json'` so it is always there. Vite 5 changed the default to
   * `.vite/manifest.json` inside the output directory, so a project that merely
   * set `manifest: true` — which is most of them, and was this framework's own
   * template until a build was actually run — has it there instead. Looking in
   * both is one `existsSync` more than Laravel does, and saves an afternoon.
   */
  private get manifestPath(): string {
    const directory = join(this.options.publicPath, this.options.buildDirectory ?? 'build')
    const named = join(directory, 'manifest.json')

    /**
     * The named path, unless only the Vite 5 default is there.
     *
     * When **neither** exists this used to answer `.vite/manifest.json`, so the
     * "no manifest" message named a path nothing in this framework writes —
     * `vite.config.ts` sets `manifest: 'manifest.json'` — and sent people looking
     * for a directory that was never going to appear. The named path is what a
     * build here produces, so that is what an absence should be reported as.
     */
    if (existsSync(named)) return named

    const legacy = join(directory, '.vite', 'manifest.json')

    return existsSync(legacy) ? legacy : named
  }

  /**
   * The manifest, read once.
   *
   * Cached because it cannot change while the process runs — a deploy replaces
   * the process — and reading a file inside every page render is a syscall per
   * request for a value that never moves.
   */
  private cached: Record<string, ManifestChunk> | undefined

  private manifest(): Record<string, ManifestChunk> | undefined {
    if (this.cached) return this.cached

    if (!existsSync(this.manifestPath)) {
      if (this.options.whenMissing === 'ignore') {
        if (!Vite.warned) {
          Vite.warned = true
          console.warn(
            `No Vite manifest at ${this.manifestPath}. Assets are not on the page. Run the build, or start the dev server.`
          )
        }

        return undefined
      }

      throw new Error(
        `No Vite manifest at ${this.manifestPath}. Run the build, or start the dev server.`
      )
    }

    this.cached = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as Record<
      string,
      ManifestChunk
    >

    return this.cached
  }
}
