import { authorize } from '@elvel/auth'
import { app } from '@elvel/core'
import { Route } from '@elvel/http'
import { TABLE } from '../app/Telescope/Recorder.ts'

/** One stored row, before its `content` is parsed back. */
type Stored = { batch_id: string | null; type: string; content: string; recorded_at: unknown }

/**
 * Reading the spike back. JSON, no dashboard — the point is the data.
 *
 * `authorize` throws a 403 rather than answering a boolean, so the ability is
 * checked before anything is read rather than beside it.
 *
 * `groupBy` and `countBy` are the framework's own: a route that hand-rolled the
 * same two loops over a `Map` was the first version, and it was longer.
 */
Route.prefix('telescope').group(() => {
  /** The most recent batches, newest first, with what each one did. */
  Route.get('/entries', async ({ query }: { query: Record<string, string> }) => {
    await authorize('viewTelescope')

    const table = await app('db').table<Stored>(TABLE)
    const rows = await table
      .orderBy('id', 'desc')
      .limit(Number(query.limit ?? 200))
      .get()

    const grouped = rows.groupBy((row) => String(row.batch_id ?? 'unbatched'))

    return {
      batches: Object.entries(grouped).map(([id, entries]) => ({
        batch: id,
        count: entries.length,
        types: [...new Set(entries.map((entry) => entry.type))].sort(),
        entries: entries.map((entry) => ({
          type: entry.type,
          recorded_at: entry.recorded_at,
          content: JSON.parse(entry.content) as unknown
        }))
      }))
    }
  }).name('telescope.entries')

  /** What the spike is really measuring: how many of each kind, and per batch. */
  Route.get('/summary', async () => {
    await authorize('viewTelescope')

    const table = await app('db').table<Stored>(TABLE)
    const rows = await table.get()

    return {
      entries: rows.count(),
      batches: Object.keys(rows.groupBy((row) => String(row.batch_id ?? 'unbatched'))).length,
      byType: rows.countBy((row) => row.type)
    }
  }).name('telescope.summary')
})
