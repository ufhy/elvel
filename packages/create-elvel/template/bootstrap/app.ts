import { join } from 'node:path'
import { Application } from '@elvel/core'
import { AppServiceProvider } from '../app/Providers/AppServiceProvider.ts'

/**
 * Bootstrap the application.
 *
 * Order is fixed by the framework and mirrors Laravel's HTTP kernel:
 * env -> config -> exceptions -> register providers -> boot providers -> routes.
 *
 * Framework providers are listed in `config/app.ts`; application providers go
 * here so they register last and can override framework bindings.
 */
export default await Application.configure(join(import.meta.dir, '..'))
  /**
   * Every config file, named — one line each, and a new file needs a line here.
   *
   * Laravel has no equivalent because it never has to: PHP resolves
   * `config/*.php` from disk at run time, every time, and there is no build step
   * to hide the directory from. Here there is. Left to read the directory, a
   * bundled application resolves those imports against a disk that may not have
   * them, and — when it does — loads a *second* copy of the framework through
   * them, so `Application.current` belongs to the copy that is not running.
   *
   * The imports are lazy so a config file can call `storage_path()` while it is
   * evaluated, and literal so a bundler can follow them.
   */
  .withConfig({
    app: () => import('../config/app.ts'),
    auth: () => import('../config/auth.ts'),
    broadcasting: () => import('../config/broadcasting.ts'),
    cache: () => import('../config/cache.ts'),
    concurrency: () => import('../config/concurrency.ts'),
    cors: () => import('../config/cors.ts'),
    database: () => import('../config/database.ts'),
    filesystems: () => import('../config/filesystems.ts'),
    hashing: () => import('../config/hashing.ts'),
    http: () => import('../config/http.ts'),
    image: () => import('../config/image.ts'),
    logging: () => import('../config/logging.ts'),
    mail: () => import('../config/mail.ts'),
    notifications: () => import('../config/notifications.ts'),
    queue: () => import('../config/queue.ts'),
    services: () => import('../config/services.ts'),
    security: () => import('../config/security.ts'),
    session: () => import('../config/session.ts'),
    spa: () => import('../config/spa.ts'),
    view: () => import('../config/view.ts'),
    vite: () => import('../config/vite.ts')
  })
  .withProviders([AppServiceProvider])
  .withRoutes(() => import('../routes/web.ts'))
  // Scheduled work lives in its own file, as Laravel's `routes/console.php`
  // does. It registers rather than routes, so it is loaded rather than mounted.
  .withConsole(() => import('../routes/console.ts'))
  .create()
