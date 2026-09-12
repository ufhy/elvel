import type { ApplicationContract } from '@elvel/contracts'
import { currentScope } from '@elvel/http'
import { Elysia } from 'elysia'
import { BAR_SCRIPT, BAR_STYLE } from '../bar/asset.ts'
import type { Baselines } from '../bar/baseline.ts'
import { type BarState, barAllows } from '../bar/enabled.ts'
import type { RequestProfiler } from '../bar/profiler.ts'
import { type BarSummary, type BatchRing, listed } from '../bar/ring.ts'
import { knowsBatches, type StoredBatch } from '../contracts.ts'
import { describe, withoutPreview } from '../panels/describe.ts'
import type { Recorder } from '../recorder.ts'
import { pathMatches } from './plugin.ts'

export type LensBarOptions = {
  state: BarState
  ring: BatchRing
  baselines: Baselines
  profiler: RequestProfiler
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
  /**
   * Whether storage is real, and so whether other processes can be seen.
   *
   * False when the bar is running on its own with no tables, in which case the
   * list is this process only — and says so, rather than showing an empty `job`
   * screen that reads as "no jobs ran".
   */
  stored: boolean
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

        /**
         * A page carrying the bar must never come from the browser's cache.
         *
         * The bar is inlined in the markup, so a cached page is a cached *tool*:
         * you change the inspector, reload, and see yesterday's build with
         * nothing saying so. Costly in production and free here — the bar only
         * injects in development, or for one authorised person.
         */
        headers.set('cache-control', 'no-store')

        return new Response(inject(html, batchId, options), {
          status: response.status,
          statusText: response.statusText,
          headers
        })
      })
      /**
       * The list, as a cursor.
       *
       * `since` is what makes a live bar possible: the page asks with the
       * highest sequence it has seen and is told only what is newer. Sequences
       * are per-process, which is fine — they are a cursor into this ring, not
       * an identity, and anything from another process arrives without one.
       */
      .get(`${prefix}`, async ({ query, request, set }) => {
        const lens: Recorder = app.make('lens')

        if (!(await barAllows(options.state, lens, request))) {
          set.status = 403

          return { message: 'Forbidden' }
        }

        const asked = Number(query.since)
        const since = Number.isSafeInteger(asked) && asked > 0 ? asked : 0

        return {
          /**
           * What the server's bar is built from.
           *
           * The page carries its own in `data-build`; a page from the browser's
           * cache carries an older one, and until this existed the only symptom
           * was a tool that quietly did not change. The client compares them and
           * says so.
           */
          build: BUILD,
          cursor: options.ring.cursor(),
          /**
           * Whether anything outside this process can be seen at all. The bar
           * says so on an empty job list rather than implying nothing ran.
           */
          crossProcess: options.stored,
          batches: [...options.ring.since(since), ...(await elsewhere(app, options, since))]
        }
      })
      /**
       * Arm the sampler for the next request.
       *
       * A GET, which for something that changes state is normally the wrong
       * verb, and the reason is worth stating rather than hiding. A POST from
       * the bar has to satisfy the application's CSRF middleware, and the bar
       * cannot get a token honestly: `csrfToken()` mints by writing to the
       * session, and by the time the bar is injected the session has already
       * been saved — so the markup carried a token no cookie ever matched. The
       * alternatives were to make every page in development write a session, or
       * to ask every application to add a path to its CSRF exemptions.
       *
       * What this actually changes is the inspector, not the application:
       * arming twice is arming once, nothing is written anywhere, and in
       * production it still has to pass `authorise()` like every route here.
       */
      .get(`${prefix}/profile`, async ({ request, set }) => {
        const lens: Recorder = app.make('lens')

        if (!(await barAllows(options.state, lens, request))) {
          set.status = 403

          return { message: 'Forbidden' }
        }

        return { armed: await options.profiler.arm() }
      })
      /** What every route seen so far usually costs. Only this process knows. */
      .get(`${prefix}/costs`, async ({ request, set }) => {
        const lens: Recorder = app.make('lens')

        if (!(await barAllows(options.state, lens, request))) {
          set.status = 403

          return { message: 'Forbidden' }
        }

        return { costs: options.baselines.costs() }
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

        /**
         * Summaries, never content.
         *
         * The first version sent whole entries, so a page with a 64 KB response
         * body cost the bar 64 KB before anybody had clicked anything. Detail is
         * one more request, and only for the entry somebody opened.
         */
        return {
          batch: { ...batch, entries: batch.entries.map(listed) },
          cursor: options.ring.cursor()
        }
      })
      .get(`${prefix}/entry/:uuid`, async ({ params, request, set }) => {
        const lens: Recorder = app.make('lens')

        if (!(await barAllows(options.state, lens, request))) {
          set.status = 403

          return { message: 'Forbidden' }
        }

        const entry = options.ring.entry(params.uuid)

        if (entry === undefined) {
          set.status = 404

          return { message: 'Not held any more.' }
        }

        /**
         * The same panels the dashboard draws, minus the mail preview.
         *
         * A preview is HTML the application composed; the dashboard renders it
         * in a sandboxed iframe on its own origin, which it can afford. Here the
         * origin is the application's own page, so it is dropped and the
         * dashboard link takes its place.
         */
        return {
          uuid: entry.uuid,
          type: entry.type,
          tags: entry.tags,
          panels: withoutPreview(describe(entry.type as never, entry.content)),
          /**
           * The raw content travels with the detail and only with the detail.
           *
           * The dashboard keeps a `Raw content` block under every entry because
           * a panel never covers everything, and the bar should not be the
           * lesser tool. One entry's content is the cost; a whole batch of them
           * was what the list endpoint stopped sending.
           */
          content: entry.content,
          dashboard: options.stored ? `/${options.path}/${entry.type}/${entry.uuid}` : undefined
        }
      })
  )
}

/**
 * Units of work from other processes.
 *
 * `bun elvel dev` runs the queue worker and the scheduler beside the server, and
 * a job's batch is flushed from the worker's own process into its own ring — a
 * ring nothing serves. The database is the only thing both can see, so when Lens
 * storage is real the list is the union of the two, this process winning on a
 * batch both know about because it has the detail.
 *
 * Never throws: a bar that takes the page down because a table is missing would
 * be worse than a bar that shows only what it has.
 */
async function elsewhere(
  app: ApplicationContract,
  options: LensBarOptions,
  since: number
): Promise<BarSummary[]> {
  // A cursor is per-process, so a later page-load asking for "what is new" gets
  // nothing from storage rather than the same rows again.
  if (!options.stored || since > 0) return []

  try {
    const repository = app.make('lens.entries')

    if (!knowsBatches(repository)) return []

    const mine = new Set(options.ring.recent().map((batch) => batch.batchId))

    return (
      (await repository.recentBatches(40))
        .filter((batch) => !mine.has(batch.batchId))
        /**
         * A stored batch containing a `request` came from an HTTP process, and
         * if the ring does not have it, it is simply older than the ring — not
         * work from somewhere else. Listing those made the bar's own history
         * reappear under "elsewhere", which is both noise and a lie. What has no
         * request entry is a job, a scheduled task or a console command, and
         * those are exactly what this exists to surface.
         */
        .filter((batch) => batch.types.request === undefined)
        /**
         * A batch of nothing but events is bookkeeping, not work.
         *
         * Every `bun elvel <anything>` opens a console batch, and for a command
         * the watcher ignores — `queue:work`, `lens:*` — all that lands in it is
         * `command.starting`. Ten of those crowded out the one job batch that
         * mattered, which is how this was found.
         */
        .filter((batch) => Object.keys(batch.types).some((type) => type !== 'event'))
        .slice(0, 20)
        .map(asSummary)
    )
  } catch {
    return []
  }
}

/**
 * A stored batch, shaped like a ring one.
 *
 * Storage does not know a batch's method, path or duration — those live on the
 * request entry, and a job batch has no request at all. The list says what it
 * knows: the kinds of entry and how many.
 */
function asSummary(batch: StoredBatch): BarSummary {
  const kinds = Object.entries(batch.types)
    .map(([type, count]) => `${count} ${type}`)
    .join(' · ')

  return {
    seq: 0,
    batchId: batch.batchId,
    at: batch.at,
    method: '',
    path: kinds,
    status: 0,
    durationMs: 0,
    /** Storage keeps entries, not timings; the shape of one is unknowable here. */
    shape: { totalMs: 0, databaseMs: 0, renderMs: 0, otherMs: 0, queries: batch.types.query ?? 0 },
    count: batch.count,
    source: 'storage',
    problems: 0,
    profiled: false
  }
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
/**
 * A short fingerprint of the bar's own code.
 *
 * Shown in the strip so "am I looking at the current build" is a glance rather
 * than an argument. Computed once: both strings are module constants.
 */
const BUILD = new Bun.CryptoHasher('md5')
  .update(BAR_SCRIPT + BAR_STYLE)
  .digest('hex')
  .slice(0, 6)

function tag(batchId: string, options: LensBarOptions): string {
  const attributes = [
    ['data-batch', batchId],
    ['data-build', BUILD],
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
