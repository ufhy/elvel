import { userOf } from '@elvel/auth'
import { view } from '@elvel/view'
import { Dashboard } from '../../../resources/views/pages/dashboard.tsx'

/**
 * The page behind the wall — and the one to replace first.
 *
 * It is here to prove the session survives the redirect and that `auth` lets a
 * signed-in visitor through; an application puts its own landing page here.
 */
export default class DashboardController {
  // `auth` has already sent a guest to sign in, remembering where they were
  // going — so `user` is present here by the time this runs.
  index(context: object) {
    const person = userOf(context as never)

    return view(Dashboard, { title: 'Dashboard', name: person.name || person.email })
  }
}
