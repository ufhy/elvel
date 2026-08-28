import { maybeUserOf } from '@elvel/auth'
import { Route, routes } from '@elvel/http'
import { view } from '@elvel/view'
import { Welcome } from '../resources/views/pages/welcome.tsx'

/**
 * The template's web routes, with the visitor's identity added.
 *
 * The welcome page shows a header when the application has somewhere to sign in
 * to — this is the kit that does, so it also answers *who*: `maybeUserOf` returns
 * the signed-in user or null, without the `auth` middleware that would turn the
 * front page into a wall.
 *
 * A closure rather than a controller, as the template has it. There is nothing
 * here a class would hold: one call, one view. The route names come from
 * `routes/auth.ts`, beside the routes themselves — rename a path without its name
 * and `routes().verify()` refuses to boot rather than leaving a header pointing at
 * a 404.
 */
Route.get('/', (context: object) =>
  view(Welcome, {
    title: 'Welcome',
    user: maybeUserOf(context as never),
    links: {
      login: routes().path('login'),
      register: routes().path('register'),
      dashboard: routes().path('dashboard')
    }
  })
).name('home')

Route.get('/health', () => ({ status: 'ok' })).name('health')
