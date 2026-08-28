import { maybeUserOf } from '@elvel/auth'
import { view } from '@elvel/view'
import { Welcome } from '../../../resources/views/pages/welcome.tsx'

/**
 * The two addresses the server answers for itself.
 *
 * Everything else is `routes/view.ts`, which hands the browser a shell and lets
 * the Vue router decide. These two do not belong there: a landing page is the
 * first thing a visitor sees and should not wait for a bundle, and `/health` is
 * for a load balancer that wants a status code rather than JavaScript.
 */
export default class PageController {
  /**
   * The landing page, server rendered like every other kit's.
   *
   * The addresses are written here rather than read from the route table. The
   * other kits ask `routes().path('login')`, which works because a page route
   * carries that name — this kit has no page routes, so there is no name to ask
   * for. What it has instead is two view routes and a client router, and these are
   * the addresses that router answers.
   */
  index(context: object) {
    return view(Welcome, {
      title: 'Welcome',
      /**
       * Who is asking, without a guard that would wall the front page.
       *
       * `maybeUserOf` answers the signed-in visitor or `null`, so the header can
       * offer the dashboard to somebody who already has one and sign-in to
       * everybody else. `auth` here would turn a landing page into a redirect.
       */
      user: maybeUserOf(context as never),
      links: {
        login: '/auth/sign-in',
        register: '/auth/sign-up',
        dashboard: '/dashboard'
      }
    })
  }

  health() {
    return { status: 'ok' }
  }
}
