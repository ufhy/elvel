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
           * The security headers, read from the container rather than imported.
           *
           * They are `@elvel/http`'s decision and this package does not depend on
           * it — and a static file cannot get them any other way, because these
           * routes skip the surrounding lifecycle. Resolved per request so a
           * policy that names a per-response nonce is still correct.
           */
          headers: this.app.bound('security.headers')
            ? (request: Request) => this.app.make('security.headers')(request)
            : undefined,
          /**
           * Where Vite writes, so its hashed names can be cached for a year.
           *
           * The environment decides the directive for the rest of `public/`,
           * whose names stay the same when their contents change. Under this
           * prefix they do not, so there is nothing for `no-cache` to protect
           * and a navigation was re-downloading the same bytes every time.
           */
          hashedPrefix: `${prefix.endsWith('/') ? prefix : `${prefix}/`}${this.config<string>(
            'vite.buildDirectory',
            'build'
          )}/`,
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
