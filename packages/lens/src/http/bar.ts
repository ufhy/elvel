import type { ApplicationContract } from '@elvel/contracts'
import { currentScope } from '@elvel/http'
import { Elysia } from 'elysia'
import { BAR_SCRIPT, BAR_STYLE } from '../bar/asset.ts'
import { type BarState, barAllows } from '../bar/enabled.ts'
import type { BatchRing } from '../bar/ring.ts'
import type { Recorder } from '../recorder.ts'
import { pathMatches } from './plugin.ts'

export type LensBarOptions = {
  state: BarState
  ring: BatchRing
  /** The dashboard path, so the bar never injects itself into Lens. */
  path: string
  /**
   * A URL template for opening a file, or empty for plain text.
   *
   * `{file}` and `{line}` are replaced. Empty by default rather than guessing at
   * `vscode://`, because a dead link on a machine without that editor is worse
   * than the path written out.
   */
  editor: string
  /** Stripped from the front of a path before it is shown. */
  root: string
}

/**
 * The inspection bar: an injector and one endpoint.
 *
 * Laravel Debugbar is a second set of collectors sitting beside Telescope's,
 * which is why an application running both pays twice and can have the two
 * disagree. This is not that. Everything on the bar was recorded by the same
 * watchers that feed the dashboard, judged by the same filters, and the bar is
 * a *reader* — the only thing added to the request path is a script tag.
 *
 * The data cannot travel inside the page, and that turns out to be a gift.
 * A batch is flushed in `onAfterResponse`, after the body has gone, so the
 * markup carries nothing but a batch id and the browser asks for the rest. A
 * Debugbar page carries its whole payload inline and grows by tens of kilobytes
 * for it; here an untouched bar costs the length of one script tag.
 */
export function lensBar(app: ApplicationContract, options: LensBarOptions) {
  const prefix = `/${options.path.replace(/^\/+|\/+$/g, '')}-api/bar`
  const skip = [`${options.path}*`, `${options.path}-api*`]

  return (
    new Elysia({ name: 'elvel:lens-bar' })
      /**
       * Before the route below, and that ordering is not cosmetic: Elysia
       * applies a lifecycle hook only to routes declared after it, inside the
       * plugin and out. Declared second, the hook missed this plugin's own
       * endpoint — which happens not to matter, since the endpoint is on the
       * skip list, and would have hidden the rule until it did.
       *
       * `onAfterHandle` and not `mapResponse`, because this is the last moment
       * the handler's own return value is visible.
       */
      .onAfterHandle({ as: 'global' }, async (context) => {
        const { request, response } = context as { request: Request; response: unknown }
        const path = new URL(request.url).pathname

        if (pathMatches(path, skip)) return

        const lens: Recorder = app.make('lens')
        const batchId = lens.batchId()

        /**
         * No batch means nothing was recorded for this request — the recorder is
         * off, paused, or the path is ignored. A bar with nothing behind it is
         * worse than no bar, so none is drawn.
         */
        if (batchId === undefined) return
        if (!(await barAllows(options.state, lens, request))) return

        /**
         * Two shapes arrive here, and handling only the first is the mistake
         * this comment exists to stop somebody repeating. A handler may return a
         * string — but `view()`, the framework's own way of rendering a page,
         * returns a `Response`. Tests written against string handlers passed
         * while no real page in the playground ever got a bar. Found by loading
         * one.
         */
        if (typeof response === 'string') return inject(response, batchId, options)

        if (!(response instanceof Response)) return
        if (!isHtml(response)) return

        /**
         * A streamed page is left alone.
         *
         * `stream()` in `@elvel/view` sends `x-accel-buffering: no` and says why
         * in its own source: nothing downstream may buffer it, or the streaming
         * is undone. Reading the body here to append to it would do exactly
         * that, and the bar would have broken the one kind of page it exists to
         * make legible.
         */
        if (response.headers.get('x-accel-buffering') === 'no') return

        const html = await response.text()
        const headers = new Headers(response.headers)

        // The body grew; a stale length would truncate the page.
        headers.delete('content-length')

        return new Response(inject(html, batchId, options), {
          status: response.status,
          statusText: response.statusText,
          headers
        })
      })
      .get(`${prefix}/:id`, async ({ params, request, set }) => {
        const lens: Recorder = app.make('lens')

        if (!(await barAllows(options.state, lens, request))) {
          set.status = 403

          return { message: 'Forbidden' }
        }

        const batch = options.ring.get(params.id)

        if (batch === undefined) {
          /**
           * Not an error, and the client knows it: the ring is filled after the
           * response is sent, so the first ask can arrive before the batch does.
           * The bar retries a few times on this exact status.
           */
          set.status = 404

          return { message: 'Not recorded yet.' }
        }

        return { batch, recent: options.ring.recent() }
      })
  )
}

function isHtml(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')
}

/** Put the tag last, or hand the page back untouched when there is nowhere for it. */
function inject(html: string, batchId: string, options: LensBarOptions): string {
  const at = html.lastIndexOf('</body>')

  if (at === -1) return html

  return `${html.slice(0, at)}${tag(batchId, options)}${html.slice(at)}`
}

/**
 * The whole injected payload.
 *
 * Attribute values are quoted with `"` and everything interpolated here is
 * either a UUID the recorder generated or a value from config, both of which
 * still go through {@link escapeAttribute} — a config file is not user input,
 * but it is also not a promise.
 */
function tag(batchId: string, options: LensBarOptions): string {
  const attributes = [
    ['data-batch', batchId],
    ['data-endpoint', `/${options.path.replace(/^\/+|\/+$/g, '')}-api/bar`],
    ['data-editor', options.editor],
    ['data-root', options.root]
  ]
    .map(([name, value]) => `${name}="${escapeAttribute(String(value))}"`)
    .join(' ')

  /**
   * The stylesheet travels as a JSON string in the script body rather than as an
   * attribute, which it was first: three kilobytes of entity-escaped CSS in a
   * `data-` attribute is unreadable in view-source and pays for every quote
   * twice.
   *
   * `</` is broken up afterwards, over the whole body. An HTML parser ends a
   * script at the first `</script` it sees regardless of what JavaScript thinks
   * it is inside, so any such sequence in the CSS or the code would truncate the
   * page — and the page here belongs to somebody else.
   */
  const body = `window.__elvelBarCss=${JSON.stringify(BAR_STYLE)};${BAR_SCRIPT}`

  /**
   * The CSP nonce, when the application is writing one.
   *
   * `@elvel/http` ships `script-src 'self' 'nonce-...'` by default, which is a
   * good default and which silently blocks every inline script not carrying the
   * nonce. The bar was injected correctly and refused by the browser until this
   * was added — nothing in the markup says so, only the console.
   */
  const nonce = currentScope()?.nonce
  const guard = nonce === undefined ? '' : ` nonce="${escapeAttribute(nonce)}"`

  return `<script${guard} ${attributes}>${body.replaceAll('</', '<\\/')}</script>`
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
