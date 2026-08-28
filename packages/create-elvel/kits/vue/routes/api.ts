import { NotFoundException } from '@elvel/core'
import { Route } from '@elvel/http'
import SessionController from '../app/Http/Controllers/Api/SessionController.ts'
import SettingsController from '../app/Http/Controllers/Api/SettingsController.ts'

/**
 * What the client reads — the other half of a shell.
 *
 * A document carries no data, so each screen asks for its own. That is the trade a
 * cacheable document makes, and it is also where every
 * guard that used to sit on a page has gone: `routes/view.ts` hands the same shell
 * to everybody, so what actually decides whether somebody sees an account is these
 * endpoints answering or refusing.
 *
 * Exact paths, and they win over the view route — measured, with a wildcard
 * registered. The catch-all at the bottom of this file covers the other direction:
 * a miss under `/api/` stays a JSON 404 rather than becoming a document, which
 * would reach a `fetch` as a parse error three layers from the mistake.
 *
 * `GET /api/session` has no guard at all, and it is the one endpoint that must not
 * have one. The shell carries no CSRF token — a token is per session, and a
 * document carrying one could not be cached — so without an unguarded way to fetch
 * it the sign-in form has nothing to post. Measured as `419 CSRF token mismatch`
 * on a fresh visit. `user: null` is a real answer there, not a failure.
 */
Route.prefix('api').group(() => {
  Route.get('/session', [SessionController, 'show']).name('api.session')

  Route.middleware('auth').group(() => {
    Route.get('/settings/profile', [SettingsController, 'profile'])

    Route.middleware('password.confirm').group(() => {
      Route.get('/settings/sessions', [SettingsController, 'sessions'])
      Route.get('/settings/passkeys', [SettingsController, 'passkeys'])
      Route.get('/settings/two-factor', [SettingsController, 'twoFactor'])
    })
  })

  /**
   * Anything else under `/api/` is a miss, and has to stay one.
   *
   * `routes/view.ts` answers every address with a document, and that is right for
   * every address a person can type — but a mistyped endpoint is not one of those.
   * Measured before this route existed: `GET /api/nothing` answered `200` and a
   * page of HTML, which reaches a `fetch` as a parse error three layers from the
   * mistake.
   *
   * A route rather than a condition inside the view handler, because that is what
   * it is: a claim on this prefix, saying it is not the client router's to answer.
   * A condition could not do it anyway: a route that matches means there is no 404
   * for a handler to see.
   *
   * Every verb, so a `POST` to a missing endpoint is a 404 rather than the
   * document route's 405.
   */
  Route.any('/{path}', () => {
    throw new NotFoundException('No such endpoint.')
  }).where('path', '.*')
})
