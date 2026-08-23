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
        // Resolve files per request in development so newly added assets are
        // picked up without a restart; precompute the route table in production.
        alwaysStatic: production,
        directive,
        maxAge
      })
    )
  }
}
