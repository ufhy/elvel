import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { JsxViewFactory } from '@elvel/view'
import { Elysia } from 'elysia'
import { IncomingEntry } from '../src/entry.ts'
import { EntryType, type EntryTypeName } from '../src/entry-type.ts'
import { lensDashboard } from '../src/http/dashboard.ts'
import { Recorder } from '../src/recorder.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'
import { EntryQueryOptions } from '../src/storage/query-options.ts'

async function dashboard(options: { open?: boolean } = {}) {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-dash')
  app.config.set('database.connections.lens-dash', { driver: 'sqlite', database: ':memory:' })

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
  if (options.open !== false) recorder.auth(() => true)

  app.instance('lens', recorder)
  app.instance('lens.entries', entries)
  app.instance('view', new JsxViewFactory())

  const router = new Elysia().use(
    lensDashboard(app, {
      path: 'lens',
      enabled: true,
      watchers: { request: { enabled: true }, query: { enabled: true } } as never
    })
  )

  return { router, entries, recorder }
}

function entry(
  type: EntryTypeName = EntryType.QUERY,
  content: Record<string, unknown> = {},
  batchId = 'b1'
) {
  return IncomingEntry.make(content).withType(type).withBatch(batchId)
}

describe('the dashboard', () => {
  test('the index sends you to requests', async () => {
    const { router } = await dashboard()

    const response = await router.handle(new Request('http://localhost/lens'))

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/lens/request')
  })

  test('a list renders a page, not JSON', async () => {
    const { router, entries } = await dashboard()

    await entries.store([
      entry(EntryType.REQUEST, { method: 'GET', uri: '/orders', responseStatus: 200, duration: 12 })
    ])

    const response = await router.handle(new Request('http://localhost/lens/request'))
    const body = await response.text()

    expect(response.headers.get('content-type')).toContain('text/html')
    expect(body.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(body).toContain('/orders')
    expect(body).toContain('GET')
  })

  /**
   * The reason a list is empty, on the page rather than in a config file.
   */
  test('an empty list says why it is empty', async () => {
    const { router } = await dashboard()

    const body = await (await router.handle(new Request('http://localhost/lens/query'))).text()

    expect(body).toContain('just empty space')
  })

  test('a detail page carries the rest of the batch', async () => {
    const { router, entries } = await dashboard()
    const subject = entry(EntryType.REQUEST, { method: 'GET', uri: '/x' }, 'together')

    await entries.store([
      subject,
      entry(EntryType.QUERY, { sql: 'select * from orders' }, 'together'),
      entry(EntryType.QUERY, { sql: 'select * from elsewhere' }, 'apart')
    ])

    const body = await (
      await router.handle(new Request(`http://localhost/lens/request/${subject.uuid}`))
    ).text()

    expect(body).toContain('Timeline · 1 related')
    expect(body).toContain('select * from orders')
    expect(body).not.toContain('select * from elsewhere')
  })

  /**
   * A recorder stores what an attacker sent, and then shows it to an
   * administrator. `@kitajs/html` does not escape by default, so this is the
   * test that keeps a recorded path from becoming a script tag in the one page
   * whose reader is always privileged.
   */
  test('a recorded value cannot become markup', async () => {
    const { router, entries } = await dashboard()
    const nasty = '/x?<script>alert(1)</script>'

    await entries.store([
      entry(EntryType.REQUEST, { method: 'GET', uri: nasty, responseStatus: 200 })
    ])

    const body = await (await router.handle(new Request('http://localhost/lens/request'))).text()

    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;')
  })

  test('a value in an entry detail cannot become markup either', async () => {
    const { router, entries } = await dashboard()
    const subject = entry(EntryType.QUERY, { sql: "select '<img src=x onerror=alert(1)>'" })

    await entries.store([subject])

    const body = await (
      await router.handle(new Request(`http://localhost/lens/query/${subject.uuid}`))
    ).text()

    expect(body).not.toContain('<img src=x')
    expect(body).toContain('&lt;img')
  })

  /**
   * The refactor's real point, tested on a type whose columns are new.
   *
   * Escaping used to be a `safe` attribute written by hand per cell, per type.
   * It is now one `<td safe>` for every column of every type — so this asserts
   * the property on a path that did not exist before, rather than only on the
   * request row that already had it.
   */
  test('a nasty value in a cache key cannot become markup', async () => {
    const { router, entries } = await dashboard()

    await entries.store([
      entry(EntryType.CACHE, {
        type: 'hit',
        key: '<img src=x onerror=alert(1)>',
        store: 'file'
      })
    ])

    const body = await (await router.handle(new Request('http://localhost/lens/cache'))).text()

    expect(body).not.toContain('<img src=x')
    expect(body).toContain('&lt;img')
  })

  /**
   * `occurrences` is counted by storage, not passed in — the first version of
   * this test set the field itself and read back `1`, because
   * `storeExceptions()` overwrites it with what it counted. So the repeats have
   * to be real.
   */
  test('each type renders its own columns, and an exception counts its repeats', async () => {
    const { router, entries } = await dashboard()

    for (let index = 0; index < 3; index++) {
      await entries.store([
        entry(EntryType.EXCEPTION, { class: 'TypeError', message: 'boom' }).withFamilyHash('same')
      ])
    }

    const body = await (await router.handle(new Request('http://localhost/lens/exception'))).text()

    expect(body).toContain('Type')
    expect(body).toContain('Seen')
    expect(body).toContain('TypeError')
    expect(body).toContain('>3<')
  })

  test('an unknown type is a 404', async () => {
    const { router } = await dashboard()

    expect((await router.handle(new Request('http://localhost/lens/nonsense'))).status).toBe(404)
  })

  /**
   * Every action the header offers has a route behind it.
   *
   * Written after finding that `pause`, `resume` and `clear` had gone missing
   * from the dashboard while their buttons stayed in the layout — the page
   * looked right in a screenshot and every button 404'd. A form whose action
   * nothing serves is invisible until somebody presses it.
   */
  test('the header buttons all reach a route', async () => {
    const { router } = await dashboard()

    const page = await (await router.handle(new Request('http://localhost/lens/request'))).text()
    const actions = [...page.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1])

    expect(actions.length).toBeGreaterThan(2)

    for (const action of actions) {
      const response = await router.handle(
        new Request(`http://localhost${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'theme=dark'
        })
      )

      expect(`${String(action)} → ${String(response.status)}`).not.toContain('404')
    }
  })

  test('pause and resume move the recorder, and clear empties it', async () => {
    const { router, entries, recorder } = await dashboard()

    await entries.store([entry(EntryType.QUERY, { sql: 'select 1' })])

    await router.handle(new Request('http://localhost/lens/pause', { method: 'POST' }))
    expect(recorder.isPaused()).toBe(true)

    await router.handle(new Request('http://localhost/lens/resume', { method: 'POST' }))
    expect(recorder.isPaused()).toBe(false)

    await router.handle(new Request('http://localhost/lens/clear', { method: 'POST' }))
    expect(await entries.get(EntryType.QUERY, new EntryQueryOptions())).toHaveLength(0)
  })

  test('every page is behind the gate', async () => {
    const { router } = await dashboard({ open: false })

    for (const path of ['/lens', '/lens/request', `/lens/request/${crypto.randomUUID()}`]) {
      expect((await router.handle(new Request(`http://localhost${path}`))).status).toBe(403)
    }
  })
})
