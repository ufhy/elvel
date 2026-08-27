import { config, NotFoundException } from '@elvel/core'
import { Route } from '@elvel/http'
import { Document } from '@elvel/spa'

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
 * The prefix is what makes two possible. One route cannot carry both guards, and
 * the guards are the reason to have routes here at all rather than leaving every
 * address to `SpaExceptionHandler`: `guest` turns somebody already signed in away
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
/**
 * A file that is not there stays not there.
 *
 * The build directory is served by `@elvel/view`, which hands over the files that
 * exist and falls through for the ones that do not — and what they fell through to
 * was the view route. Measured: a stale `/build/assets/index-abc123.js` from a
 * cached document answered `200` and a *page*, so a browser waiting for JavaScript
 * got HTML and the application failed with nothing saying why.
 *
 * The prefix is read from config rather than written twice: `vite.buildDirectory`
 * is what the tags on the page point at.
 */
Route.any(`/${config<string>('vite.buildDirectory', 'build')}/{path}`, () => {
  throw new NotFoundException('No such file.')
}).where('path', '.*')

const shell = {
  mountId: config<string>('spa.mountId', 'app'),

  /**
   * What every document carries in its `<head>`, written where it is rendered.
   *
   * This was a `spa.head` config key, read on every document to solve a problem
   * these two routes remove: the exception handler renders a document for an
   * unknown address and has nowhere to hang an icon. Nothing unknown reaches it
   * now — the routes below answer every address a browser can type — so the markup
   * belongs at the call site, where a reader can see it.
   */
  head: '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  title: config<string>('app.name', 'Elvel')
}

Route.prefix('auth')
  .middleware('guest')
  .group(() => {
    Route.view('/{path}', Document, { ...shell, entry: 'src/auth.ts' }).where('path', '.*')
  })

Route.middleware('auth').group(() => {
  Route.view('/{path}', Document, { ...shell, entry: 'src/main.ts' }).where('path', '.*')
})
