import { Route } from '@elvel/http'
import PageController from '../app/Http/Controllers/PageController.ts'

/**
 * Web routes — Laravel's `routes/web.php`, and read the same way.
 *
 * Almost empty in this kit, and that is the shape a client-routed application
 * takes: `routes/view.ts` answers every address a browser asks for, so what
 * belongs here is only what the *server* must answer for itself.
 *
 * `/` is the landing page, server rendered as it is in every other kit. It is the
 * first thing a visitor sees, and a starter screen that waits for a bundle to
 * arrive is a poor first minute — so it does not go through `routes/view.ts`.
 *
 * An exact route wins over the view wildcard, measured, so this is what answers
 * `/`. The Vue router keeps its own `/` for a navigation that happens inside the
 * application: `frontend/src/routers/app.ts` redirects it to the dashboard.
 *
 * `/health` is here for the same reason and a different one. A load balancer
 * asking it wants a status code, not JavaScript, and it must answer before any
 * bundle is built.
 */
Route.get('/', [PageController, 'index']).name('home')
Route.get('/health', [PageController, 'health']).name('health')
