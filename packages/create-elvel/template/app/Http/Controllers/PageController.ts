import { controller } from '@elvel/core'
import { routes } from '@elvel/http'
import { view } from '@elvel/view'
import { Welcome } from '../../../resources/views/pages/welcome.tsx'

/**
 * A controller is an Elysia instance, which is what keeps the request context
 * fully typed inside handlers. The name drives Elysia's plugin deduplication.
 *
 * This file stays `.ts`: components are plain functions, so no JSX syntax is
 * needed here. Rename it to `.tsx` if you would rather write markup inline.
 */
export default controller('page')
  .get('/', () =>
    view(Welcome, {
      title: 'Welcome',
      /**
       * Only the auth routes that exist.
       *
       * `--kit=none` names none of them and the header stays empty; a kit that
       * ships sign-in names them and it fills in. Laravel's welcome page asks the
       * same question with `Route::has('login')`, for the same reason: a starter
       * page must not link to a page the application does not have.
       */
      links: {
        login: routes().path('login'),
        register: routes().path('register'),
        dashboard: routes().path('dashboard')
      }
    })
  )
  .get('/health', () => ({ status: 'ok' }))
