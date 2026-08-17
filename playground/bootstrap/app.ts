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
  // Named rather than read from the directory, so a build can see them. The
  // template's `bootstrap/app.ts` carries the long version of why.
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
