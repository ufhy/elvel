import { ConsoleServiceProvider } from '@elysian/console'
import { Env, env } from '@elysian/core'
import { ViewServiceProvider } from '@elysian/view'

export default {
  name: env('APP_NAME', 'Elysian'),

  env: env('APP_ENV', 'local'),

  debug: env('APP_DEBUG', true),

  url: env('APP_URL', 'http://localhost:3000'),

  port: Env.number('PORT', 3000),

  host: env('HOST', ''),

  /**
   * Framework service providers. Application providers live in
   * `bootstrap/app.ts` so they boot after these.
   */
  providers: [ConsoleServiceProvider, ViewServiceProvider]
}
