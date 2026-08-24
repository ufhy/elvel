import { createApp } from 'vue'
import AuthApp from './AuthApp.vue'
import { boot } from './api.ts'
import { applyStoredAppearance } from './composables/useAppearance.ts'
import { authRouter } from './routers/auth.ts'
import './style.css'

/**
 * The auth screens — seven forms, and nothing else.
 *
 * Its own entry, so a guest signing in downloads this and not the application
 * behind it. `Auth/AuthPageController` names this file, and
 * `frontend/vite.config.ts` builds it as a second entry.
 *
 * It does boot. Not for data — most of these screens have nobody signed in — but
 * for the CSRF token, which a shell cannot carry and a form cannot post without.
 * `GET /api/session` is unguarded for exactly this reason, and the same answer
 * gives the two screens that do have somebody the address to show.
 */
applyStoredAppearance()

await boot()

createApp(AuthApp).use(authRouter).mount('#app')
