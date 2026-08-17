import { userOf } from '@elvel/auth'
import { controller } from '@elvel/core'
import { middleware } from '@elvel/http'
import { view } from '@elvel/view'
import { Dashboard } from '../../../resources/views/pages/dashboard.tsx'

/**
 * The page behind the wall — and the one to replace first.
 *
 * It is here to prove the session survives the redirect and that `auth` lets a
 * signed-in visitor through; an application puts its own landing page here.
 */
export default controller('dashboard').get(
  '/dashboard',
  // `auth` has already sent a guest to sign in, remembering where they were
  // going — so `user` is present here by the time this runs.
  (context) => {
    const person = userOf(context)

    return view(Dashboard, { title: 'Dashboard', name: person.name || person.email })
  },
  middleware('auth')
)
