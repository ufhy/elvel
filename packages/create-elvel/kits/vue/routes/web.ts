import { Route } from '@elvel/http'
import PageController from '../app/Http/Controllers/PageController.ts'

/**
 * Web routes — Laravel's `routes/web.php`, and read the same way.
 *
 * Almost empty in this kit, and that is the shape a client-routed application
 * takes: `routes/view.ts` answers every address a browser asks for, so what
 * belongs here is only what the *server* must answer for itself.
 *
 * `/` is not here. The template names it `home` and renders a page; in this kit
 * the Vue router owns `/` — `frontend/src/routers/app.ts` — and a route here
 * would win over the view route and answer a document the client cannot boot
 * from. One address, one owner.
 *
 * `/health` stays because nothing about it is a page. A load balancer asking it
 * wants a status code, not JavaScript, and it must answer before any bundle is
 * built.
 */
Route.get('/health', [PageController, 'health']).name('health')
