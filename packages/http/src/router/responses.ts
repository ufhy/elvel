import { app } from '@elvel/core'

/**
 * The two routes that need no handler written for them.
 *
 * `Route::view` and `Route::redirect` are shorthands in Laravel because a
 * routing file is full of both, and every one of them written by hand is four
 * lines saying nothing.
 */

/**
 * Render a component as the whole response.
 *
 * The factory comes from the container rather than an import: routing lives in
 * `@elvel/http` and views in `@elvel/view`, and an application serving only JSON
 * should not pull a view factory in behind its router. An application that never
 * registered `ViewServiceProvider` and calls `Route.view` gets a container error
 * naming `view`, which is the truth about what is missing.
 */
export async function renderView(
  component: unknown,
  props: Record<string, unknown>
): Promise<Response> {
  const html = await app('view').render(component as never, props as never)

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/**
 * A bare redirect.
 *
 * Laravel's `Route::redirect` defaults to **302** and `permanentRedirect` is 301.
 * Worth stating because the docs describe the argument as optional and the
 * default matters: a 301 cached by a browser is very hard to take back.
 */
export function redirectResponse(to: string, status = 302): Response {
  return new Response(null, { status, headers: { location: to } })
}
