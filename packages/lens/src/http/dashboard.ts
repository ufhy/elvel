import type { ApplicationContract } from '@elvel/contracts'
import { render } from '@elvel/view'
import { Elysia } from 'elysia'
import { EntryType, type EntryTypeName, entryTypes } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { EntryQueryOptions } from '../storage/query-options.ts'
import type { WatcherConfig } from '../watchers/index.ts'
import { WATCHER_FOR, watcherStatus } from './status.ts'
import { Entries } from './views/entries.tsx'
import { Entry } from './views/entry.tsx'

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

  return new Elysia({ name: 'elvel:lens-dashboard' })
    .onBeforeHandle({ as: 'scoped' }, async ({ request, set }) => {
      const lens: Recorder = app.make('lens')

      if (await lens.check(request)) return

      set.status = 403

      return 'Forbidden'
    })
    .get(prefix, ({ redirect }) => redirect(`${prefix}/${EntryType.REQUEST}`, 302))
    .get(`${prefix}/:type`, async ({ params, query, set }) => {
      const type = asType(params.type)

      if (type === undefined) {
        set.status = 404

        return 'No such entry type.'
      }

      const entries = await app.make('lens.entries').get(type, EntryQueryOptions.fromRequest(query))

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
          entries
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
          batch: await repository.get(undefined, EntryQueryOptions.forBatch(entry.batchId))
        })
      )
    })
}

/** A rendered page, told apart from the plain-text refusals above it. */
function html(set: { headers: Record<string, string | number> }, markup: string): string {
  set.headers['content-type'] = 'text/html; charset=utf-8'

  return markup
}

function asType(candidate: string): EntryTypeName | undefined {
  return entryTypes().find((type) => type === candidate)
}
