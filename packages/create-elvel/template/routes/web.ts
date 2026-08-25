import { Route } from '@elvel/http'
import PageController from '../app/Http/Controllers/PageController.ts'

/**
 * Web routes — the equivalent of Laravel's `routes/web.php`, and read the same
 * way.
 *
 * Nothing is exported. `Route` collects what this file declares while it is being
 * imported, and the framework compiles the collection once the file has finished.
 * That is what lets `.name()` and `.where()` sit *after* the route they describe.
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
Route.get('/', [PageController, 'index']).name('home')
Route.get('/health', [PageController, 'health']).name('health')
