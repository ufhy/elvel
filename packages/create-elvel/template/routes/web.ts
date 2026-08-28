import { Route, routes } from '@elvel/http'
import { view } from '@elvel/view'
import { Welcome } from '../resources/views/pages/welcome.tsx'

/**
 * Web routes — the equivalent of Laravel's `routes/web.php`, and read the same
 * way.
 *
 * Nothing is exported. `Route` collects what this file declares while it is being
 * imported, and the framework compiles the collection once the file has finished.
 * That is what lets `.name()` and `.where()` sit *after* the route they describe.
 *
 * A handler is either a closure or `[Controller, 'method']`, exactly as Laravel
 * takes `fn () => …` or `[Controller::class, 'method']`. Both pages below are
 * closures because neither has anything a class would hold; reach for a controller
 * when several related actions belong together or there is logic worth testing on
 * its own. The request context a method would have received is the closure's
 * argument.
 *
 * ```ts
 * Route.get('/users/{id}', [UserController, 'show']).name('users.show').whereNumber('id')
 *
 * Route.middleware('auth').prefix('admin').name('admin.').group(() => {
 *   Route.resource('photos', PhotoController)
 * })
 *
 * Route.view('/{path}', MainLayout, { title: 'App' }).where('path', '.*')
 * Route.fallback(() => view(NotFound, {}))
 * ```
 */
Route.get('/', () =>
  view(Welcome, {
    title: 'Welcome',
    /**
     * Only the auth routes that exist.
     *
     * `--kit=none` names none of them and the header stays empty; a kit that ships
     * sign-in names them and it fills in. Laravel's welcome page asks the same
     * question with `Route::has('login')`, for the same reason: a starter page must
     * not link to a page the application does not have.
     */
    links: {
      login: routes().path('login'),
      register: routes().path('register'),
      dashboard: routes().path('dashboard')
    }
  })
).name('home')

/**
 * A status code, and nothing that has to be built first.
 *
 * A load balancer asking this wants an answer before any bundle exists, which is
 * why it is here rather than behind anything that renders.
 */
Route.get('/health', () => ({ status: 'ok' })).name('health')
