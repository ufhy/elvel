import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

  constructor(
    private readonly options: {
      /** Where the build wrote its output, relative to the public directory. */
      buildDirectory?: string
      publicPath: string
      /** Written by `vite dev`; its presence is what "development" means. */
      hotFile?: string
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

  /** Is a dev server running? */
  get hot(): boolean {
    return existsSync(this.hotFilePath)
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
      return ['@vite/client', ...entries]
        .map((entry) => this.tagFor(`${origin}/${entry}`, entry))
        .join('')
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

    return tags.join('')
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

    return existsSync(named) ? named : join(directory, '.vite', 'manifest.json')
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
