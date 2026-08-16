import { Application } from '@elysian/core'
import { AppServiceProvider } from '../app/Providers/AppServiceProvider.ts'

/**
 * The same application, bootstrapped for a bundle.
 *
 * `bootstrap/app.ts` lets the framework read `config/` from disk, which is right
 * while developing and cannot survive `bun build`: those imports are resolved at
 * run time, so the bundle loads a second copy of the framework through them and
 * the helpers inside a config file reach for an `Application.current` belonging
 * to the copy that is not running.
 *
 * Naming the files fixes both halves at once. A literal `import('./x.ts')` is
 * something a bundler can follow, so the config ends up inside the bundle; and
 * it is still lazy, so it is evaluated after the application exists — which
 * `config/filesystems.ts` needs, since it calls `storage_path()` as it loads.
 *
 * The cost is that a new config file has to be named here as well. That is the
 * trade for a single-file deploy; `bootstrap/app.ts` stays as it was for
 * everything else.
 *
 * The base path is the working directory, not `import.meta.dir`: inside a bundle
 * that directory is wherever the bundle was written, which is not where the
 * application's `storage/`, `database/` and `resources/` are. `APP_BASE_PATH`
 * overrides it for a deployment that runs the binary from somewhere else.
 */
export default await Application.configure(process.env.APP_BASE_PATH ?? process.cwd())
  .withConfig({
    app: () => import('../config/app.ts'),
    auth: () => import('../config/auth.ts'),
    broadcasting: () => import('../config/broadcasting.ts'),
    cache: () => import('../config/cache.ts'),
    concurrency: () => import('../config/concurrency.ts'),
    cookies: () => import('../config/cookies.ts'),
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
    session: () => import('../config/session.ts'),
    view: () => import('../config/view.ts')
  })
  .withProviders([AppServiceProvider])
  .withRoutes(() => import('../routes/web.ts'))
  .create()
