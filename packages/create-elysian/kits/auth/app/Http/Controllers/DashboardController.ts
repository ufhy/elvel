import { controller } from '@elysian/core'
import { middleware } from '@elysian/http'
import { view } from '@elysian/view'
import { Dashboard } from '../../../resources/views/pages/dashboard.tsx'
import { account } from '../../Support/auth.ts'

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
    const person = account(context)

    return view(Dashboard, { title: 'Dashboard', name: person.name || person.email })
  },
  middleware('auth')
)
