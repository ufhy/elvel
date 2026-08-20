import { maybeUserOf } from '@elvel/auth'
import { controller } from '@elvel/core'
import { routes } from '@elvel/http'
import { view } from '@elvel/view'
import { Welcome } from '../../../resources/views/pages/welcome.tsx'

/**
 * The base template's page controller, with the visitor's identity added.
 *
 * The welcome page shows a header when the application has somewhere to sign in
 * to — this is the kit that does, so it also answers *who*: `maybeUserOf` returns
 * the signed-in user or null, without the `auth` middleware that would turn the
 * front page into a wall.
 *
 * The route names come from the auth controllers, registered beside the routes
 * themselves. If one is renamed and its name is not, `routes().verify()` refuses
 * to boot rather than leaving a header linking somewhere that answers 404.
 */
export default controller('page')
  .get('/', (context) =>
    view(Welcome, {
      title: 'Welcome',
      user: maybeUserOf(context),
      links: {
        login: routes().path('login'),
        register: routes().path('register'),
        dashboard: routes().path('dashboard')
      }
    })
  )
  .get('/health', () => ({ status: 'ok' }))
