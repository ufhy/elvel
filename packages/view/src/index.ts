import type { ViewComponent } from '@elvel/contracts'
import { app } from '@elvel/core'

export type { ViewComponent } from '@elvel/contracts'
export { type ClassInput, classes, json, styles } from './attributes.ts'
export { JsxViewFactory, type ViewFactoryOptions } from './factory.ts'
export { ViewServiceProvider } from './provider.ts'
export { once, prepend, push, pushOnce, resolveStacks, stack, withStacks } from './stacks.ts'
export { Vite } from './vite.ts'
export { vite } from './vite-helper.ts'

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

/**
 * Stream a page as it renders — `view()`'s counterpart for slow pages.
 *
 * The whole page is rendered before `view()` answers, so a page whose slowest
 * query takes two seconds shows nothing for two seconds: no title, no layout,
 * no spinner. Streaming sends the shell immediately and the rest as it comes,
 * which is the difference between a blank tab and a page that is filling in.
 *
 * Each part is a component with its own props, rendered in order. A part that
 * throws does not take the response with it — the status is long since sent —
 * so it is replaced by an HTML comment naming the failure and reported, which
 * is the only honest thing left to do once bytes are on the wire.
 *
 * ```ts
 * .get('/dashboard', () => stream([
 *   [Shell, { title: 'Dashboard' }],
 *   [SlowStats, { userId }],
 *   [Footer, {}]
 * ]))
 * ```
 */
export function stream(
  parts: Array<[ViewComponent<never>, unknown]>,
  init: ResponseInit = {},
  report?: (error: unknown) => void
): Response {
  const factory = app('view')

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()

      for (const [component, props] of parts) {
        try {
          controller.enqueue(encoder.encode(await factory.render(component, props as never)))
        } catch (error) {
          report?.(error)

          // The status and half the page are already sent; an exception here
          // would truncate the response with no explanation in the markup.
          controller.enqueue(
            encoder.encode(`<!-- part failed: ${escapeComment(String(error))} -->`)
          )
        }
      }

      controller.close()
    }
  })

  return new Response(body, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Nothing downstream may buffer it, or the streaming is undone by a proxy.
      'cache-control': 'no-transform',
      'x-accel-buffering': 'no',
      ...init.headers
    }
  })
}

/** `--` would close the comment early and spill the message into the page. */
function escapeComment(value: string): string {
  return value.replaceAll('--', '- -').slice(0, 200)
}
