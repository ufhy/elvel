import type { ApplicationContract } from '@elvel/contracts'
import { Elysia } from 'elysia'
import { isClearable } from '../contracts.ts'
import { type EntryTypeName, entryTypes } from '../entry-type.ts'
import { refreshMonitoring } from '../pause.ts'
import type { Recorder } from '../recorder.ts'
import { EntryQueryOptions } from '../storage/query-options.ts'
import type { WatcherConfig } from '../watchers/index.ts'
import { WATCHER_FOR, watcherStatus } from './status.ts'

export type LensRoutesOptions = {
  /** Where the dashboard lives, without slashes — `lens` by default. */
  path: string
  enabled: boolean
  watchers: WatcherConfig
}

/**
 * The read side: one pair of endpoints per entry type, plus clear.
 *
 * Telescope writes 44 routes by hand and gives them 18 controllers, all but two
 * of which are a subclass declaring an entry type and a watcher class. The
 * generic half is `EntryController::index/show`, so that is what exists here and
 * the types come from `EntryType` rather than from a file of near-identical
 * classes.
 *
 * `index` is a POST in Telescope, because its filters travel in the body. Kept:
 * a dashboard that pages by cursor sends a body either way, and matching means
 * the client is the same client.
 */
export function lensRoutes(app: ApplicationContract, options: LensRoutesOptions) {
  const prefix = `/${options.path.replace(/^\/+|\/+$/g, '')}-api`

  const router = new Elysia({ name: 'elvel:lens-routes' })
    /**
     * The gate, on every route in this plugin.
     *
     * Telescope's `Authorize` middleware, and the same refusal: `abort(403)`.
     * The default is closed — see `Recorder.auth`.
     */
    .onBeforeHandle({ as: 'scoped' }, async ({ request, set }) => {
      const lens: Recorder = app.make('lens')

      if (await lens.check(request)) return

      set.status = 403

      return { message: 'Forbidden' }
    })

  /**
   * The monitored tags — Telescope's three routes, same verbs.
   *
   * `POST .../delete` rather than `DELETE` because Telescope does it that way,
   * and a dashboard form can only send GET or POST without JavaScript.
   */
  router.get(`${prefix}/monitored-tags`, async () => {
    return { tags: await app.make('lens.entries').monitoring() }
  })

  router.post(`${prefix}/monitored-tags`, async ({ body, set }) => {
    const tag = tagFrom(body)

    if (tag === undefined) {
      set.status = 422

      return { message: 'A tag is required.' }
    }

    await app.make('lens.entries').monitor([tag])
    await refreshMonitoring(app, app.make('lens'))

    set.status = 204

    return null
  })

  router.post(`${prefix}/monitored-tags/delete`, async ({ body, set }) => {
    const tag = tagFrom(body)

    if (tag === undefined) {
      set.status = 422

      return { message: 'A tag is required.' }
    }

    await app.make('lens.entries').stopMonitoring([tag])
    await refreshMonitoring(app, app.make('lens'))

    set.status = 204

    return null
  })

  router.delete(`${prefix}/entries`, async ({ set }) => {
    const repository = app.make('lens.entries')

    if (!isClearable(repository)) {
      set.status = 501

      return { message: 'This Lens driver cannot be cleared.' }
    }

    await repository.clear()

    set.status = 204

    return null
  })

  for (const type of entryTypes()) {
    router.post(`${prefix}/${type}`, async ({ query }) => {
      return {
        entries: await entries(app, type, EntryQueryOptions.fromRequest(query)),
        status: statusFor(app, options, type)
      }
    })

    router.get(`${prefix}/${type}/:id`, async ({ params, set }) => {
      const repository = app.make('lens.entries')
      const entry = await repository.find(params.id)

      if (entry === undefined) {
        set.status = 404

        return { message: 'No such entry.' }
      }

      /**
       * The batch travels with the entry.
       *
       * This is the feature, not a convenience: an exception is worth little
       * without the query that raised it and the request that ran it, and they
       * are related by nothing but sharing a batch. Telescope's biggest
       * component by far is the one that renders this.
       */
      return {
        entry: entry.toJSON(),
        batch: (await repository.get(undefined, EntryQueryOptions.forBatch(entry.batchId))).map(
          (related) => related.toJSON()
        )
      }
    })
  }

  return router
}

/**
 * The tag from a form post or a JSON body, trimmed, or nothing.
 *
 * A blank tag would be monitored forever and match nothing, so it is refused
 * rather than stored.
 */
function tagFrom(body: unknown): string | undefined {
  const tag = (body as { tag?: unknown } | undefined)?.tag

  if (typeof tag !== 'string') return undefined

  const trimmed = tag.trim()

  return trimmed === '' ? undefined : trimmed
}

async function entries(
  app: ApplicationContract,
  type: EntryTypeName,
  options: EntryQueryOptions
): Promise<unknown[]> {
  const found = await app.make('lens.entries').get(type, options)

  return found.map((entry) => entry.toJSON())
}

function statusFor(app: ApplicationContract, options: LensRoutesOptions, type: EntryTypeName) {
  return watcherStatus(
    app.make('lens'),
    options.enabled,
    options.watchers,
    WATCHER_FOR[type] ?? type
  )
}
