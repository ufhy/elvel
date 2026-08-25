import { createApp } from 'vue'
import App from './App.vue'
import { boot } from './api.ts'
import { applyStoredAppearance } from './composables/useAppearance.ts'
import { router } from './routers/app.ts'
import './style.css'

/**
 * The application, behind the auth screens.
 *
 * The document is a shell and carries nothing, so the first thing this does is ask
 * who is asking — `GET /api/session`, which also hands over the CSRF token this
 * page's writes will need. **Awaited before mounting**, so no component ever renders
 * against an empty user, which is the shape that produced a header with no name in
 * it and a sign-out button that 419'd.
 *
 * The server has already refused a guest by this point: `spa.areas` guards every
 * address this router owns with `auth`. So the await is about *having* the answer,
 * not about deciding anything.
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
createApp(App).use(router).mount('[data-spa-root]')
