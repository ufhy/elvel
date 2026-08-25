import { Route } from '@elvel/http'
import { t } from 'elysia'
import ApiAuthController from '../app/Http/Controllers/ApiAuthController.ts'

/**
 * API routes — Laravel's `routes/api.php`.
 *
 * Its own file rather than lines inside `routes/web.ts`, for the reason Laravel
 * splits them: these routes have a prefix of their own, no session and no CSRF,
 * and somebody asking "what does this API expose" should find one file that
 * answers it. `bootstrap/app.ts` names it alongside `routes/web.ts`.
 */
Route.prefix('api').group(() => {
  /**
   * Six a minute, as Fortify does it.
   *
   * Without the throttle `/api/login` is a credential-stuffing endpoint. And
   * registration is a write — an open one is a way to fill somebody's table.
   */
  Route.post('/register', [ApiAuthController, 'register'])
    .name('api.register')
    .middleware('throttle:6,1')
    .validate({ body: t.Object({ name: t.String(), email: t.String(), password: t.String() }) })

  Route.post('/login', [ApiAuthController, 'login'])
    .name('api.login')
    .middleware('throttle:6,1')
    .validate({ body: t.Object({ email: t.String(), password: t.String() }) })

  Route.middleware('auth').group(() => {
    Route.get('/user', [ApiAuthController, 'user']).name('api.user')
    Route.post('/logout', [ApiAuthController, 'logout']).name('api.logout')
  })
})
