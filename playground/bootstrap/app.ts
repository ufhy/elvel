import { join } from 'node:path'
import { Application } from '@elysian/core'
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
  .withProviders([AppServiceProvider])
  .withRoutes(() => import('../routes/web.ts'))
  .create()
