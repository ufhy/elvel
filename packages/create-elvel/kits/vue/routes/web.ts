import { maybeUserOf } from '@elvel/auth'
import { Route } from '@elvel/http'
import { view } from '@elvel/view'
import { Welcome } from '../resources/views/pages/welcome.tsx'

/**
 * Web routes — Laravel's `routes/web.php`, and read the same way.
 *
 * Almost empty in this kit, and that is the shape a client-routed application
 * takes: `routes/view.ts` answers every address a browser asks for, so what
 * belongs here is only what the *server* must answer for itself.
 *
 * Both are closures rather than a controller, which `Route` takes anywhere it
 * takes `[Controller, 'method']` — Laravel's `Route::get('/', fn () => …)`. A
 * controller earns its keep when a class holds several related actions or any
 * logic worth testing on its own; two pages that read nothing do not. The context
 * a handler would have received is the closure's argument, so `maybeUserOf` works
 * here exactly as it would in a method.
 *
 * `/` is the landing page, server rendered as it is in every other kit. It is the
 * first thing a visitor sees, and a starter screen that waits for a bundle to
 * arrive is a poor first minute — so it does not go through `routes/view.ts`. An
 * exact route wins over the view wildcard, measured, so this is what answers it.
 * The Vue router keeps its own `/` for a navigation that happens inside the
 * application: `frontend/src/routers/app.ts` redirects it to the dashboard.
 *
 * `/health` is here for a different reason. A load balancer asking it wants a
 * status code, not JavaScript, and it must answer before any bundle is built.
 */
Route.get('/', (context: object) =>
  view(Welcome, {
    title: 'Welcome',
    /**
     * Who is asking, without a guard that would wall the front page.
     *
     * `maybeUserOf` answers the signed-in visitor or `null`, so the header offers
     * the dashboard to somebody who already has one and sign-in to everybody else.
     * `auth` here would turn a landing page into a redirect.
     */
    user: maybeUserOf(context as never),
    /**
     * The addresses, written here rather than read from the route table.
     *
     * The other kits ask `routes().path('login')`, which works because a page
     * route carries that name. This kit has no page routes — two view routes and a
     * client router instead — so these are the addresses that router answers.
     */
    links: {
      login: '/auth/sign-in',
      register: '/auth/sign-up',
      dashboard: '/dashboard'
    }
  })
).name('home')

Route.get('/health', () => ({ status: 'ok' })).name('health')
