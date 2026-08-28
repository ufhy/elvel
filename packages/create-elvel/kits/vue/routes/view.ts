import { Route } from '@elvel/http'
import { Shell } from '../resources/views/components/shell.tsx'

/**
 * The view routes — Laravel's `Route::view('{path}', 'main')->middleware('auth')`.
 *
 * Two of them, and that is the whole backend's knowledge of this application's
 * pages: there is a signed-in half and a guest half, and neither knows a single
 * address. The list of screens lives in `frontend/src/routers/`, once. Adding one
 * is a line there and nothing here.
 *
 * Declarative on purpose. `Route.view` renders a component with props and takes no
 * handler, so there is nowhere for a condition to accumulate — which is what keeps
 * these two lines readable as *routing* rather than as code that happens to answer
 * a request.
 *
 * The component is this application's own — `resources/views/components/shell.tsx`.
 * A document is markup, so it lives with the other views, where changing what it
 * carries does not mean reading a framework package to learn what is allowed.
 *
 * The entry is the only prop, because it is the only thing these two disagree
 * about. The icon, the title and the mount point are markup and are written in the
 * view — a route is not the place to hand a page a string of HTML.
 *
 * The prefix is what makes two possible. One route cannot carry both guards, and
 * the guards are the reason to have routes here at all rather than letting a 404
 * handler answer every address: `guest` turns somebody already signed in away
 * from the sign-in screen, and `auth` sends a stranger to it. Measured with both
 * registered — `/auth/sign-in` is not swallowed by `/{path}`, and the exact routes
 * in `auth.ts`, `settings.ts` and `api.ts` all still answer for themselves.
 *
 * One entry per half, which is the point of splitting them: a guest downloads the
 * seven forms of `src/auth.ts` and not the application behind them.
 *
 * `/verify-email` and `/confirm-password` are **not** under this prefix, and that
 * is not an oversight. Both are shown to somebody who is already signed in — one
 * confirms an address, the other a password — so `guest` would bounce them. They
 * belong to the half below, and `frontend/src/routers/app.ts` mounts them there.
 */
Route.prefix('auth')
  .middleware('guest')
  .group(() => {
    Route.view('/{path}', Shell, { entry: 'src/auth.ts' }).where('path', '.*')
  })

Route.middleware('auth').group(() => {
  Route.view('/{path}', Shell, { entry: 'src/main.ts' }).where('path', '.*')
})
