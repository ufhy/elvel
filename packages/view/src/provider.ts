import { staticPlugin } from '@elysiajs/static'
import { ServiceProvider } from '@elysian/core'
import { JsxViewFactory } from './factory.ts'

declare module '@elysian/contracts' {
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

    this.use(
      await staticPlugin({
        assets: this.config('view.publicPath', this.app.publicPath()),
        prefix: this.config('view.staticPrefix', '/'),
        indexHTML: false,
        // Resolve files per request in development so newly added assets are
        // picked up without a restart; precompute the route table in production.
        alwaysStatic: production,
        directive: production ? 'public' : 'no-cache',
        maxAge: production ? 86_400 : 0
      })
    )
  }
}
