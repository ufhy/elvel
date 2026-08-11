import { staticPlugin } from '@elysiajs/static'
import { ServiceProvider } from '@elysian/core'
import { EdgeViewFactory } from './factory.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    view: EdgeViewFactory
  }
}

export class ViewServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('view', (app) => {
      return new EdgeViewFactory({
        path: this.config('view.path', app.resourcePath('views')),
        disks: this.config('view.disks', {}),
        cache: this.config('view.cache', app.isProduction()),
        globals: {
          app_name: app.config.get('app.name', 'Elysian'),
          app_env: app.environment(),
          app_url: app.config.get('app.url', ''),
          config: (key: string, fallback?: unknown) => app.config.get(key, fallback),
          ...this.config<Record<string, unknown>>('view.globals', {})
        }
      })
    })
  }

  override async boot(): Promise<void> {
    // Resolve eagerly so a bad views path fails at boot, not on first request.
    this.app.make('view')

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
