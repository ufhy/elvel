import { describe, expect, test as it } from 'bun:test'
import { test } from '@elvel/testing'
import { TABLE } from '../app/Telescope/Recorder.ts'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * The spike: what a Telescope-shaped tool costs on this framework.
 *
 * What is under test is not the recorder — it is the claim that the framework
 * already emits enough to build one, and that a request's worth of it can be
 * correlated. Ten of Telescope's watchers turned out to be a single wildcard
 * listener, because the dispatcher hands a wildcard the event's **name** as well
 * as its payload.
 *
 * Every assertion here failed at least once on the way, and each failure was the
 * point:
 *
 * - the recorder recorded its own `insert`, and the migration hung
 * - a `Date` in the payload is not bindable, and the unhandled rejection took the
 *   whole server down
 * - `RequestLifecycle.finishing` is the **error path**, not every response, so
 *   there were no request entries at all
 * - the 404 path then ran both hooks and recorded itself twice
 * - and the flush is fire-and-forget, so a test that read the table straight
 *   after a request read it empty — a `sleep` would have passed and been a flake
 *
 * The one it could not fix is skipped below: request slots leak between two
 * `app.handle()` calls from one frame, which is issue #9.
 */

type Stored = { batch_id: string | null; type: string; content: string }

/**
 * Run a request and wait for its batch to reach the table.
 *
 * `onAfterResponse` is fire-and-forget — `app.handle()` returns before the hook
 * runs at all — so the first version of these tests read an empty table and
 * reported "nothing was recorded" while the flush had not yet begun. Awaiting the
 * write in flight was not enough either: there was no write in flight to await.
 * So the count is the signal, and `drained` throws instead of hanging.
 */
async function visit(path: string): Promise<void> {
  const telescope = app.make('telescope')
  const before = telescope.flushes()

  await test(app).get(path)
  await telescope.drained(before)
}

async function entries(): Promise<Stored[]> {
  const table = await app.make('db').table<Stored>(TABLE)

  return (await table.orderBy('id', 'asc').get()).all()
}

async function clear(): Promise<void> {
  const table = await app.make('db').table(TABLE)

  await table.delete()
}

/** The batches an entry list contains, in the order they first appear. */
function batches(rows: Stored[]): string[] {
  return [...new Set(rows.map((row) => row.batch_id ?? 'unbatched'))]
}

describe('the telescope spike', () => {
  it('records the request, and gives it a batch of its own', async () => {
    await clear()

    await visit('/check/articles')

    const rows = await entries()
    const requests = rows.filter((row) => row.type === 'request')

    expect<number>(requests.length).toBe(1)
    expect<number>(batches(rows).length).toBe(1)
    expect<string | null>(requests[0]?.batch_id ?? null).not.toBeNull()

    const content = JSON.parse(requests[0]?.content ?? '{}') as { path: string; status: number }

    expect<string>(content.path).toBe('/check/articles')
    expect<number>(content.status).toBe(200)
  })

  /**
   * The claim the whole spike rests on.
   *
   * The watchers never see the `Request` — an event listener is handed a payload
   * and nothing else — so without a per-request slot there would be nothing to
   * correlate by, and every entry would be an island.
   */
  it('puts the queries a request ran in that request’s batch', async () => {
    await clear()

    await visit('/check/articles')

    const rows = await entries()
    const queries = rows.filter((row) => row.type === 'query')

    expect<boolean>(queries.length > 0).toBe(true)
    expect<number>(batches(rows).length).toBe(1)

    // Every entry, whatever its kind, belongs to the one request.
    const single = batches(rows)[0]

    expect<boolean>(rows.every((row) => (row.batch_id ?? 'unbatched') === single)).toBe(true)
  })

  /**
   * Skipped, and the reason is the spike's most useful output.
   *
   * Two `app.handle()` calls from one frame **share** a request context, so the
   * second request inherits the first's batch, finds it already completed and
   * writes nothing. That is not the recorder's bug — it is issue #9, in the
   * single-request-context change: `enterRequestContext` inherits what surrounds
   * it so `AuthManager.runWith` keeps working, and `enterWith` inside `handle()`
   * reaches the caller's frame.
   *
   * It does not affect a served request — each one arrives in its own frame — but
   * it does affect every test that makes two, including through `test(app)`.
   * Un-skip this when #9 is fixed; it is the assertion that will prove it.
   */
  it.skip('keeps two requests apart', async () => {
    await clear()

    await visit('/check/articles')
    await visit('/check/cache/basics')

    const rows = await entries()

    expect<number>(batches(rows).length).toBe(2)
    expect<number>(rows.filter((row) => row.type === 'request').length).toBe(2)
  })

  /**
   * Cache events, which are ten of the entries on one playground route — and the
   * reason the wildcard listener is worth more than ten hand-written ones.
   */
  it('records what a route did to the cache', async () => {
    await clear()

    await visit('/check/cache/basics')

    const rows = await entries()
    const kinds = new Set(
      rows
        .filter((row) => row.type === 'cache')
        .map((row) => (JSON.parse(row.content) as { event: string }).event)
    )

    expect<boolean>(kinds.has('cache.hit')).toBe(true)
    expect<boolean>(kinds.has('cache.missed')).toBe(true)
  })

  /**
   * One entry, not two.
   *
   * An unmatched URL runs Elysia's `onAfterResponse` **and**
   * `RequestLifecycle.finishing`, because the second exists precisely for the
   * path the first cannot serve alone. Both call `complete()`; the second finds
   * the batch already completed.
   */
  it('records an unmatched request once, not once per hook', async () => {
    await clear()

    await visit('/no-such-route-here')

    const rows = await entries()

    expect<number>(rows.filter((row) => row.type === 'request').length).toBe(1)
  })

  /**
   * The recorder must not record itself.
   *
   * Writing an entry is a query, and a query is an event. Without the guard the
   * first `insert` dispatches `db.query`, which records an entry, which inserts…
   * — found by hanging `elvel migrate` before a single request was served.
   */
  it('never records its own writes', async () => {
    await clear()

    await visit('/check/articles')

    const rows = await entries()
    const own = rows.filter((row) => row.content.includes(TABLE))

    expect<number>(own.length).toBe(0)
  })
})
