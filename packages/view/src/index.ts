import { app } from '@elysian/core'

export { EdgeViewFactory, type ViewFactoryOptions } from './factory.ts'
export { ViewServiceProvider } from './provider.ts'

/**
 * Render a view into an HTML response — Laravel's `view()` helper.
 *
 * Returns a `Response` (not a string) so Elysia sends `text/html` without the
 * caller having to set headers. Use `render()` when you need the raw markup,
 * for example to embed it in an email later.
 *
 * ```ts
 * .get('/', () => view('pages.landing', { title: 'Home' }))
 * ```
 */
export async function view(
  template: string,
  data: Record<string, unknown> = {},
  init: ResponseInit = {}
): Promise<Response> {
  const html = await app('view').render(template, data)

  return new Response(html, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...init.headers
    }
  })
}

/** Render a view to a string. */
export function render(template: string, data: Record<string, unknown> = {}): Promise<string> {
  return app('view').render(template, data)
}
