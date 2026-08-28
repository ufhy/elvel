import { ServiceProvider } from '@elvel/core'
import { staticPlugin } from '@elysiajs/static'
import { compressedAssets } from './compression.ts'
import { JsxViewFactory } from './factory.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    view: JsxViewFactory
  }
}

export class ViewServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(
      'view',
      () =>
        new JsxViewFactory({
          doctype: this.config<boolean>('view.doctype', true)
        })
    )
  }

  /**
   * The contributors, asked **per request** rather than resolved at boot.
   *
   * Which looks wasteful and is not. A container lookup per served file is cheap,
   * and resolving once here would capture whatever was bound at the moment this
   * provider booted — so a provider registered afterwards, which the application
   * boots immediately, would contribute nothing and say nothing about it. The same
   * reason the security headers were always read this way.
   */
  private assetHeaders(): (request: Request) => Record<string, string> {
    /**
     * The security headers **last**, so nothing can weaken them.
     *
     * Order is the whole of the access control here. `assets.headers` is bound by
     * whichever package wants a header for a particular file, and merged after the
     * security headers it would be able to replace the Content Security Policy on
     * every static file the application serves — from a binding whose stated job is
     * a cache directive. Merged before them it cannot.
     *
     * It costs nothing, because the one header an asset contributor needs to
     * *override* is `cache-control`, and the security headers do not set that.
     */
    const bindings = ['assets.headers', 'security.headers']

    return (request: Request) => {
      const headers: Record<string, string> = {}

      for (const binding of bindings) {
        if (!this.app.bound(binding)) continue

        const contribute = this.app.make(binding) as (request: Request) => Record<string, string>

        Object.assign(headers, contribute(request))
      }

      return headers
    }
  }

  override async boot(): Promise<void> {
    if (this.config<boolean>('view.serveStatic', true) === false) return

    const production = this.app.isProduction()
    const root = this.config<string>('view.publicPath', this.app.publicPath())
    const prefix = this.config<string>('view.staticPrefix', '/')
    const directive = production ? 'public' : 'no-cache'
    const maxAge = production ? 86_400 : 0

    /**
     * Compression first, because the static plugin never gives the response back.
     *
     * Its routes skip the surrounding lifecycle, so an `onAfterHandle` around it
     * is never called — measured, in both `alwaysStatic` modes. Mounted ahead of
     * it, this answers what it can and passes everything else through.
     */
    if (this.config<boolean>('view.compressStatic', true) !== false) {
      this.use(
        compressedAssets({
          root,
          prefix,
          directive,
          maxAge,
          minimumBytes: this.config<number>('view.compressMinimumBytes', 1024),
          /**
           * Headers other packages decide, read from the container, not imported.
           *
           * Two contribute today and neither is a dependency of this one. The
           * security headers are `@elvel/http`'s decision, resolved per request so
           * a policy naming a per-response nonce is still correct. `assets.headers`
           * is for a header that belongs to *one file* — `@elvel/vite` uses it to
           * send `Service-Worker-Allowed` for the worker it built, which is the
           * only way a worker under `/build/` may claim the whole site.
           *
           * They have to arrive here because a static file cannot get them any
           * other way: these routes skip the surrounding lifecycle, so a header set
           * globally never reaches a served file.
           */
          headers: this.assetHeaders(),
          /**
           * Where Vite writes its *hashed* names, which can be cached for a year.
           *
           * The environment decides the directive for the rest of `public/`,
           * whose names stay the same when their contents change. Under this
           * prefix they do not, so there is nothing for `no-cache` to protect
           * and a navigation was re-downloading the same bytes every time.
           *
           * The assets directory and not the whole build directory, which is a
           * measured correction. Vite writes hashed files under `assets/` and
           * unhashed ones at the build root — `manifest.json`, and whatever a
           * plugin emits: `sw.js`, `registerSW.js`, `manifest.webmanifest`. Those
           * were going out `max-age=31536000, immutable` under names with no hash
           * in them, so a browser had no reason to fetch the next version for a
           * year. A `vite-plugin-pwa` application would have frozen at its first
           * deployed service worker, with nothing failing anywhere.
           */
          hashedPrefix: `${prefix.endsWith('/') ? prefix : `${prefix}/`}${this.config<string>(
            'vite.buildDirectory',
            'build'
          )}/${this.config<string>('vite.assetsDirectory', 'assets')}/`,
          // Only where filenames carry a content hash and cannot go stale.
          cache: production
        })
      )
    }

    this.use(
      await staticPlugin({
        assets: root,
        prefix,
        indexHTML: false,
        /**
         * A route per existing file, in every environment — never a `/*`.
         *
         * `false` makes the plugin resolve per request, and to do that it claims
         * `/*`. That claim answers its own 404s, which puts it in front of every
         * route the application registered afterwards: measured, an application
         * whose only catch-all was `.get('/*')` answered it in production and
         * **404 in development**, from the same source. A framework whose routing
         * depends on the environment is a framework that cannot be developed
         * against.
         *
         * Laravel never has this problem because static files are not routes
         * there. Its nginx configuration is `try_files $uri $uri/ /index.php` and
         * Valet's `isStaticFile()` is `file_exists(...) ? path : false` — the file
         * if it is there, the router if it is not. `true` is the shape of that
         * here: the table holds only files that exist, so a miss falls through.
         *
         * What `false` was for — an asset added while the server is running — is
         * covered by `compressedAssets` above, which is an `onRequest` that stats
         * the path per request and answers everything it can resolve. This plugin
         * is left with range requests, which it implements and that does not.
         */
        alwaysStatic: true,
        directive,
        maxAge
      })
    )
  }
}
