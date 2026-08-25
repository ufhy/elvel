import { routes } from '@elvel/http'
import { view } from '@elvel/view'
import { Welcome } from '../../../resources/views/pages/welcome.tsx'

/**
 * A controller is a plain class, and a route names one of its methods.
 *
 * ```ts
 * // routes/web.ts
 * Route.get('/', [PageController, 'index'])
 * ```
 *
 * Each method receives Elysia's request context — `{ params, query, body, request,
 * set }` — so anything the framework knows about the request is destructured from
 * its argument rather than reached for globally.
 *
 * One instance is built per route and reused, so a field on a controller is shared
 * by every request that reaches it. Keep them stateless.
 *
 * This file stays `.ts`: components are plain functions, so no JSX syntax is
 * needed here. Rename it to `.tsx` if you would rather write markup inline.
 */
export default class PageController {
  index() {
    return view(Welcome, {
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
  }

  health() {
    return { status: 'ok' }
  }
}
