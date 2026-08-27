import { createApp } from 'vue'
import AuthApp from './AuthApp.vue'
import { boot } from './api.ts'
import { applyStoredAppearance } from './composables/useAppearance.ts'
import { authRouter } from './routers/auth.ts'
import './style.css'

/**
 * The auth screens — five forms, and nothing else.
 *
 * Its own entry, so a guest signing in downloads this and not the application
 * behind it. `routes/view.ts` names this file on the one route under the `auth`
 * prefix, and `frontend/vite.config.ts` builds it as a second entry.
 *
 * Five, not seven: `/verify-email` and `/confirm-password` are shown to somebody
 * already signed in, so they ship in the application's bundle and are mounted by
 * `routers/app.ts`. The `guest` guard on this half would have turned their visitor
 * away.
 *
 * It does boot. Not for data — nobody is signed in on any of these — but for the
 * CSRF token, which a shell cannot carry and a form cannot post without. `GET
 * /api/session` is unguarded for exactly this reason.
 */
applyStoredAppearance()

await boot()

/**
 * Mounted on what the document marked, not on a name repeated here.
 *
 * `spa.mountId` decides the id on the server, and a client naming `#app` in a
 * second file has to agree with it or the application silently never appears — no
 * error, no console message. `[data-spa-root]` is on the same element whatever the
 * id says.
 */
createApp(AuthApp).use(authRouter).mount('[data-spa-root]')
