import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { Elysia } from 'elysia'
import type { IncomingEntry } from '../src/entry.ts'
import { EntryType, type EntryTypeName } from '../src/entry-type.ts'
import { lensPlugin, pathMatches } from '../src/http/plugin.ts'
import { describe as describe_ } from '../src/panels/describe.ts'
import { Recorder } from '../src/recorder.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'
import { EntryQueryOptions } from '../src/storage/query-options.ts'
import { RequestWatcher } from '../src/watchers/request.ts'

/**
 * A router with Lens mounted, on its own in-memory database.
 *
 * Driven through `router.handle()` rather than a listening server: the hooks
 * under test are `onRequest` and `onAfterResponse`, and both run on `handle`.
 */
async function harness(
  options: { ignorePaths?: string[]; onlyPaths?: string[]; watcher?: Record<string, unknown> } = {}
) {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-http')
  app.config.set('database.connections.lens-http', { driver: 'sqlite', database: ':memory:' })

  const db = new ConnectionManager(app)
  const schema = await db.schema()

  await schema.create('lens_entries', (table) => {
    table.bigIncrements('sequence')
    table.uuid('uuid')
    table.uuid('batch_id')
    table.string('family_hash').nullable()
    table.boolean('should_display_on_index').default(true)
    table.string('type', 20)
    table.longText('content')
    table.dateTime('created_at').nullable()
    table.unique(['uuid'])
  })
  await schema.create('lens_entries_tags', (table) => {
    table.uuid('entry_uuid')
    table.string('tag')
    table.primary(['entry_uuid', 'tag'])
  })
  await schema.create('lens_entries_monitoring', (table) => {
    table.string('tag').primary()
  })

  const entries = new DatabaseEntriesRepository(db, { table: 'lens_entries' })
  const recorder = new Recorder()
  recorder.enable(true)

  app.instance('lens', recorder)
  app.instance('lens.entries', entries)

  const router = new Elysia()
    .use(
      lensPlugin(app, {
        onlyPaths: options.onlyPaths ?? [],
        ignorePaths: options.ignorePaths ?? [],
        requestWatcher: new RequestWatcher(options.watcher ?? { sizeLimit: 64 })
      })
    )
    .get('/plain', () => 'hello')
    .get('/json', () => ({ ok: true, token: 'shhh' }))
    .post('/login', ({ body }) => ({ received: body }))
    .get('/boom', () => new Response('no', { status: 503 }))
    .get('/big', () => ({ blob: 'x'.repeat(4000) }))

  return { router, entries, recorder }
}

/**
 * Wait for `count` flushes, then read.
 *
 * `router.handle()` resolves before `onAfterResponse` has stored anything, so
 * reading straight after it found an empty table. A sleep made the suite pass
 * and would have made it flake; the flush counter is the same wait without the
 * guesswork.
 */
async function drained(recorder: Recorder, count: number): Promise<void> {
  const deadline = Date.now() + 2000

  while (recorder.flushes() < count) {
    if (Date.now() > deadline) throw new Error(`only ${recorder.flushes()} of ${count} flushed`)

    await Bun.sleep(1)
  }
}

async function recorded(entries: DatabaseEntriesRepository) {
  return await entries.get(EntryType.REQUEST, new EntryQueryOptions())
}

describe('the lens plugin', () => {
  test('records a request that matched a route', async () => {
    const { router, entries, recorder } = await harness()

    await router.handle(new Request('http://localhost/plain'))
    await drained(recorder, 1)

    const found = await recorded(entries)

    expect(found).toHaveLength(1)
    expect(found[0]?.content.method).toBe('GET')
    expect(found[0]?.content.uri).toBe('/plain')
    expect(found[0]?.content.responseStatus).toBe(200)
  })

  /**
   * The failure that cost the spike every request entry it should have had.
   *
   * Every Elysia hook except `onRequest` belongs to a handler, so an unmatched
   * path runs none of them — and an unmatched path is exactly the request
   * somebody opens the dashboard to understand.
   */
  test('records a 404, which has no handler at all', async () => {
    const { router, entries, recorder } = await harness()

    await router.handle(new Request('http://localhost/nothing-here'))
    await drained(recorder, 1)

    const found = await recorded(entries)

    expect(found).toHaveLength(1)
    expect(found[0]?.content.responseStatus).toBe(404)
    expect(found[0]?.content.uri).toBe('/nothing-here')
  })

  test('a query run by the handler joins the request in one batch', async () => {
    const { router, entries, recorder } = await harness()

    await router.handle(new Request('http://localhost/plain'))
    await drained(recorder, 1)

    const requests = await recorded(entries)
    const batch = new EntryQueryOptions()
    batch.batchId = requests[0]?.batchId

    const together = await entries.get(undefined, batch)

    expect(together.map((entry) => entry.type)).toContain(EntryType.REQUEST)
  })

  test('an ignored path is never recorded', async () => {
    const { router, entries } = await harness({ ignorePaths: ['plain*'] })

    await router.handle(new Request('http://localhost/plain'))

    expect(await recorded(entries)).toHaveLength(0)
  })

  test('onlyPaths records nothing else', async () => {
    const { router, entries, recorder } = await harness({ onlyPaths: ['json*'] })

    await router.handle(new Request('http://localhost/plain'))
    await router.handle(new Request('http://localhost/json'))
    await drained(recorder, 1)

    const found = await recorded(entries)

    expect(found).toHaveLength(1)
    expect(found[0]?.content.uri).toBe('/json')
  })

  test('two requests get their own batches', async () => {
    const { router, entries, recorder } = await harness()

    await Promise.all([
      router.handle(new Request('http://localhost/plain')),
      router.handle(new Request('http://localhost/json'))
    ])
    await drained(recorder, 2)

    const found = await recorded(entries)

    expect(found).toHaveLength(2)
    expect(new Set(found.map((entry) => entry.batchId)).size).toBe(2)
  })

  test('the authorization header is masked', async () => {
    const { router, entries, recorder } = await harness()

    await router.handle(
      new Request('http://localhost/plain', { headers: { authorization: 'Bearer sekrit' } })
    )
    await drained(recorder, 1)

    const headers = (await recorded(entries))[0]?.content.headers as Record<string, string>

    expect(headers.authorization).toBe('********')
    expect(JSON.stringify(headers)).not.toContain('sekrit')
  })

  test('a password in the payload is masked', async () => {
    const { router, entries, recorder } = await harness()

    await router.handle(
      new Request('http://localhost/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.test', password: 'sekrit' })
      })
    )
    await drained(recorder, 1)

    const payload = (await recorded(entries))[0]?.content.payload as Record<string, unknown>

    expect(payload.password).toBe('********')
    expect(payload.email).toBe('ada@example.test')
    expect(JSON.stringify(payload)).not.toContain('sekrit')
  })

  /**
   * The leak a review of the introducing commit found.
   *
   * Telescope reaches hidden keys with `Arr::get`/`Arr::set`, which walk
   * `user.password`. The first version here masked only top-level keys, so a
   * nested password went into the row in full while the configuration said it
   * would not — worse than not offering the option.
   */
  test('a nested key named by a dotted path is masked', async () => {
    const { router, entries, recorder } = await harness()

    recorder.hideRequestParameters(['user.password', 'deep.a.b'])

    await router.handle(
      new Request('http://localhost/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user: { email: 'ada@example.test', password: 'nested-sekrit' },
          deep: { a: { b: 'buried-sekrit' } }
        })
      })
    )
    await drained(recorder, 1)

    const payload = (await recorded(entries))[0]?.content.payload as {
      user: Record<string, unknown>
      deep: { a: Record<string, unknown> }
    }

    expect(payload.user.password).toBe('********')
    expect(payload.user.email).toBe('ada@example.test')
    expect(payload.deep.a.b).toBe('********')
    expect(JSON.stringify(payload)).not.toContain('sekrit')
  })

  test('masking does not mutate what the handler still holds', async () => {
    const { router, recorder } = await harness()

    recorder.hideRequestParameters(['user.password'])

    const response = await router.handle(
      new Request('http://localhost/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: { password: 'still-here' } })
      })
    )
    await drained(recorder, 1)

    // The handler echoes its own body; masking must not have reached it.
    expect(await response.text()).toContain('still-here')
  })

  test('a status code can be ignored', async () => {
    const { router, entries, recorder } = await harness({ watcher: { ignoreStatusCodes: [503] } })

    await router.handle(new Request('http://localhost/boom'))
    await drained(recorder, 1)

    expect(await recorded(entries)).toHaveLength(0)
  })

  test('a method can be ignored', async () => {
    const { router, entries, recorder } = await harness({ watcher: { ignoreHttpMethods: ['GET'] } })

    await router.handle(new Request('http://localhost/plain'))
    await drained(recorder, 1)

    expect(await recorded(entries)).toHaveLength(0)
  })

  /**
   * Telescope's arithmetic, kept deliberately: `intdiv(len, 1000) <= limit`.
   *
   * Which means a limit of `0` still keeps anything under a kilobyte — the
   * first version of this test asserted otherwise, and was wrong about
   * Telescope rather than about the code. So the body has to cross the line.
   */
  test('a response over the size limit is dropped rather than truncated', async () => {
    const { router, entries, recorder } = await harness({ watcher: { sizeLimit: 1 } })

    await router.handle(new Request('http://localhost/big'))
    await drained(recorder, 1)

    expect((await recorded(entries))[0]?.content.response).toBe('Purged By Lens')
  })

  test('a response under the size limit is kept whole', async () => {
    const { router, entries, recorder } = await harness({ watcher: { sizeLimit: 64 } })

    await router.handle(new Request('http://localhost/json'))
    await drained(recorder, 1)

    expect((await recorded(entries))[0]?.content.response).toEqual({ ok: true, token: 'shhh' })
  })
})

describe('pathMatches', () => {
  test('a trailing star is a prefix, and nothing else is a pattern', () => {
    expect(pathMatches('/lens-api/requests', ['lens-api*'])).toBe(true)
    expect(pathMatches('/lens', ['lens'])).toBe(true)
    expect(pathMatches('/lensing', ['lens'])).toBe(false)
    expect(pathMatches('/plain', [])).toBe(false)
  })
})

/**
 * Two things a request entry did not say, and both answer the question that
 * brings somebody to the bar: what ran before my handler, and who for.
 */
describe('what ran before the handler, and who for', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    request: new Request('http://localhost/articles/7'),
    status: 302,
    duration: 4,
    route: '/articles/:id',
    ...over
  })

  const recorded = (over: Record<string, unknown> = {}) => {
    const kept: IncomingEntry[] = []
    const lens = {
      recording: () => true,
      hidden: () => ({ headers: [], parameters: [], responseParameters: [] }),
      record: (_type: EntryTypeName, entry: IncomingEntry) => kept.push(entry)
    } as unknown as Recorder

    new RequestWatcher({ sizeLimit: 64 }).record(lens, facts(over) as never)

    return kept[0] as IncomingEntry
  }

  test('the middleware chain is recorded in declaration order', () => {
    const entry = recorded({ middleware: ['auth', 'verified', 'can:update,article'] })

    expect(entry.content.middleware).toEqual(['auth', 'verified', 'can:update,article'])
  })

  /** A route with none is an empty list, not a missing field. */
  test('and a route with none says so', () => {
    expect(recorded().content.middleware).toEqual([])
  })

  test('the signed-in user is recorded by id, and tagged', () => {
    const entry = recorded({ userId: 7 })

    expect(entry.content.user).toBe(7)
    expect(entry.tags).toContain('user:7')
  })

  /**
   * Only the id. A name or an address is the page's contents, and this entry
   * hides those everywhere else.
   */
  test('a guest carries neither', () => {
    const entry = recorded()

    expect(entry.content.user).toBeNull()
    expect(entry.tags.some((tag) => tag.startsWith('user:'))).toBe(false)
  })

  test('the panel shows both, and drops them when there are none', () => {
    const shown = describe_(EntryType.REQUEST, {
      method: 'GET',
      uri: '/x',
      middleware: ['auth', 'verified'],
      user: 7
    })
    const rows = (shown[0] as { rows: Array<[string, string]> }).rows
    const labels = rows.map(([label]) => label)

    expect(rows).toContainEqual(['Middleware', 'auth → verified'])
    expect(rows).toContainEqual(['Signed in as', '7'])

    const guest = describe_(EntryType.REQUEST, { method: 'GET', uri: '/x', middleware: [] })
    const quiet = (guest[0] as { rows: Array<[string, string]> }).rows.map(([label]) => label)

    expect(labels).toContain('Middleware')
    expect(quiet).not.toContain('Middleware')
    expect(quiet).not.toContain('Signed in as')
  })
})
