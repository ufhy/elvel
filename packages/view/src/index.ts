import type { ViewComponent } from '@elysian/contracts'
import { app } from '@elysian/core'

export type { ViewComponent } from '@elysian/contracts'
export { JsxViewFactory, type ViewFactoryOptions } from './factory.ts'
export { ViewServiceProvider } from './provider.ts'

/**
 * Render a view component into an HTML response.
 *
 * The component is passed by reference, not by name, so its props are checked
 * here — a renamed or missing prop is a compile error, not a blank page:
 *
 * ```ts
 * .get('/', () => view(Landing, { title: 'Welcome' }))
 * ```
 *
 * Components with no required props may omit the second argument.
 */
export async function view<Props>(
  component: ViewComponent<Props>,
  props: Props,
  init?: ResponseInit
): Promise<Response>
export async function view(
  component: ViewComponent<{}>,
  props?: {},
  init?: ResponseInit
): Promise<Response>
export async function view<Props>(
  component: ViewComponent<Props>,
  props: Props = {} as Props,
  init: ResponseInit = {}
): Promise<Response> {
  const html = await app('view').render(component, props)

  return new Response(html, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...init.headers
    }
  })
}

/** Render a view component to a string, for embedding elsewhere (email, tests). */
export function render<Props>(component: ViewComponent<Props>, props: Props): Promise<string>
export function render(component: ViewComponent<{}>, props?: {}): Promise<string>
export function render<Props>(
  component: ViewComponent<Props>,
  props: Props = {} as Props
): Promise<string> {
  return app('view').render(component, props)
}
