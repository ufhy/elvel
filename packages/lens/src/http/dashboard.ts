import type { ApplicationContract } from '@elvel/contracts'
import { cookie, queueCookie } from '@elvel/http'
import { render } from '@elvel/view'
import { Elysia } from 'elysia'
import { isClearable } from '../contracts.ts'
import { EntryType, type EntryTypeName, entryTypes } from '../entry-type.ts'
import { cacheOf, PAUSE_KEY, PAUSE_TTL, refreshMonitoring } from '../pause.ts'
import type { Recorder } from '../recorder.ts'
import { EntryQueryOptions } from '../storage/query-options.ts'
import type { WatcherConfig } from '../watchers/index.ts'
import { WATCHER_FOR, watcherStatus } from './status.ts'
import { Entries } from './views/entries.tsx'
import { Entry } from './views/entry.tsx'
import type { Theme } from './views/layout.tsx'
import { Monitoring } from './views/monitoring.tsx'

export type LensDashboardOptions = {
  path: string
  enabled: boolean
  watchers: WatcherConfig
}

/**
 * The dashboard: three routes, server-rendered, no bundle.
 *
 * Telescope serves one catch-all page and lets a Vue router own every path
 * inside it, which is why the package ships a built 1.6MB `app.js` and inlines
 * it off disk. There is no bundle here — a page is a TSX function, so the routes
 * are real routes, each one is linkable, and there is nothing to build before
 * the dashboard works.
 *
 * Every route is gated the same way the API is. A dashboard is a plainer target
 * than the API it reads: it is the URL somebody bookmarks.
 *
 * One thing shipping `.tsx` from a package asks of the application, and the only
 * thing: its own `tsconfig.json` decides the JSX runtime, so it needs
 * `"jsxImportSource": "@kitajs/html"` — which every scaffolded Elvel
 * application already has, and which is why `@kitajs/html` is a real dependency
 * here rather than a peer.
 */
export function lensDashboard(app: ApplicationContract, options: LensDashboardOptions) {
  const prefix = `/${options.path.replace(/^\/+|\/+$/g, '')}`

  return (
    new Elysia({ name: 'elvel:lens-dashboard' })
      .onBeforeHandle({ as: 'scoped' }, async ({ request, set }) => {
        const lens: Recorder = app.make('lens')

        if (await lens.check(request)) return

        set.status = 403

        return 'Forbidden'
      })
      .get(prefix, ({ redirect }) => redirect(`${prefix}/${EntryType.REQUEST}`, 302))
      /**
       * Declared before `:type`, or the type route would swallow it.
       *
       * Elysia matches a literal segment ahead of a parameter, so the order is not
       * strictly required — but relying on that is the kind of thing that changes
       * under somebody in a minor release.
       */
      /**
       * The header's buttons, as forms.
       *
       * Telescope's are Vue handlers against its API. A server-rendered page has
       * no bundle to hang a handler on, so these are ordinary posts that redirect
       * back — which also means they work with JavaScript off, and are covered by
       * the application's CSRF like any other form.
       */
      .post(`${prefix}/pause`, async ({ redirect }) => {
        await setPaused(app, true)

        return redirect(`${prefix}/${EntryType.REQUEST}`, 303)
      })
      .post(`${prefix}/resume`, async ({ redirect }) => {
        await setPaused(app, false)

        return redirect(`${prefix}/${EntryType.REQUEST}`, 303)
      })
      .post(`${prefix}/clear`, async ({ redirect }) => {
        const repository = app.make('lens.entries')

        if (isClearable(repository)) await repository.clear()

        return redirect(`${prefix}/${EntryType.REQUEST}`, 303)
      })
      /**
       * Remember a theme, in a cookie the server reads back.
       *
       * A cookie rather than `localStorage` because the page is rendered on the
       * server: the choice has to be known *before* the HTML is written, or the
       * first paint is the wrong colour and then corrects itself.
       */
      .post(`${prefix}/theme`, ({ body, redirect }) => {
        const wanted = (body as { theme?: unknown } | undefined)?.theme

        queueCookie('lens_theme', wanted === 'dark' ? 'dark' : 'light', {
          maxAge: 60 * 60 * 24 * 365,
          sameSite: 'lax',
          httpOnly: false
        })

        return redirect(`${prefix}/${EntryType.REQUEST}`, 303)
      })
      .get(`${prefix}/monitoring`, async ({ set }) => {
        return html(
          set,
          await render(Monitoring, {
            path: options.path,
            paused: app.make('lens').isPaused(),
            theme: chosenTheme(),
            tags: await app.make('lens.entries').monitoring()
          })
        )
      })
      .post(`${prefix}/monitoring`, async ({ body, redirect }) => {
        const tag = tagFrom(body)

        if (tag !== undefined) {
          await app.make('lens.entries').monitor([tag])
          await refreshMonitoring(app, app.make('lens'))
        }

        return redirect(`${prefix}/monitoring`, 303)
      })
      .post(`${prefix}/monitoring/delete`, async ({ body, redirect }) => {
        const tag = tagFrom(body)

        if (tag !== undefined) {
          await app.make('lens.entries').stopMonitoring([tag])
          await refreshMonitoring(app, app.make('lens'))
        }

        return redirect(`${prefix}/monitoring`, 303)
      })
      .get(`${prefix}/:type`, async ({ params, query, set }) => {
        const type = asType(params.type)

        if (type === undefined) {
          set.status = 404

          return 'No such entry type.'
        }

        const asked = EntryQueryOptions.fromRequest(query)
        const entries = await app.make('lens.entries').get(type, asked)

        return html(
          set,
          await render(Entries, {
            path: options.path,
            type,
            status: watcherStatus(
              app.make('lens'),
              options.enabled,
              options.watchers,
              WATCHER_FOR[type] ?? type
            ),
            paused: app.make('lens').isPaused(),
            theme: chosenTheme(),
            entries,
            limit: asked.limit,
            tag: asked.tag
          })
        )
      })
      .get(`${prefix}/:type/:id`, async ({ params, set }) => {
        const repository = app.make('lens.entries')
        const entry = await repository.find(params.id)

        if (entry === undefined) {
          set.status = 404

          return 'No such entry.'
        }

        return html(
          set,
          await render(Entry, {
            path: options.path,
            entry,
            batch: await repository.get(undefined, EntryQueryOptions.forBatch(entry.batchId)),
            paused: app.make('lens').isPaused(),
            theme: chosenTheme()
          })
        )
      })
  )
}

/** A rendered page, told apart from the plain-text refusals above it. */
function html(set: { headers: Record<string, string | number> }, markup: string): string {
  set.headers['content-type'] = 'text/html; charset=utf-8'

  return markup
}

/** The tag from a form post, trimmed, or nothing. A blank tag matches nothing. */
function tagFrom(body: unknown): string | undefined {
  const tag = (body as { tag?: unknown } | undefined)?.tag

  if (typeof tag !== 'string') return undefined

  const trimmed = tag.trim()

  return trimmed === '' ? undefined : trimmed
}

/**
 * Pause or resume, in the cache and in the recorder.
 *
 * Both: the cache is what survives a restart and reaches other processes, and
 * the flag on the recorder is what the synchronous record path reads.
 */
async function setPaused(app: ApplicationContract, paused: boolean): Promise<void> {
  const cache = cacheOf(app)

  if (cache !== undefined) {
    if (paused) await cache.store().put(PAUSE_KEY, true, PAUSE_TTL)
    else await cache.store().forget(PAUSE_KEY)
  }

  app.make('lens').setPaused(paused)
}

/** What the viewer chose, if anything. Anything unrecognised is nothing. */
function chosenTheme(): Theme {
  const value = cookie('lens_theme')

  return value === 'dark' || value === 'light' ? value : undefined
}

function asType(candidate: string): EntryTypeName | undefined {
  return entryTypes().find((type) => type === candidate)
}
