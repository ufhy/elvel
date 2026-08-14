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
  constructor(
    private readonly options: {
      /** Where the build wrote its output, relative to the public directory. */
      buildDirectory?: string
      publicPath: string
      /** Written by `vite dev`; its presence is what "development" means. */
      hotFile?: string
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

  private get manifestPath(): string {
    return join(this.options.publicPath, this.options.buildDirectory ?? 'build', 'manifest.json')
  }

  /**
   * The manifest, read once.
   *
   * Cached because it cannot change while the process runs — a deploy replaces
   * the process — and reading a file inside every page render is a syscall per
   * request for a value that never moves.
   */
  private cached: Record<string, ManifestChunk> | undefined

  private manifest(): Record<string, ManifestChunk> {
    if (this.cached) return this.cached

    if (!existsSync(this.manifestPath)) {
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
