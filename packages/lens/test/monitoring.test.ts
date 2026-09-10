import { describe, expect, test } from 'bun:test'
import { Application, enterWorkContext } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { JsxViewFactory } from '@elvel/view'
import { Elysia } from 'elysia'
import { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { lensDashboard } from '../src/http/dashboard.ts'
import { lensRoutes } from '../src/http/routes.ts'
import { refreshMonitoring } from '../src/pause.ts'
import { Recorder } from '../src/recorder.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'
import { EntryQueryOptions } from '../src/storage/query-options.ts'

async function stage() {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-monitoring')
  app.config.set('database.connections.lens-monitoring', {
    driver: 'sqlite',
    database: ':memory:'
  })

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
  recorder.auth(() => true)

  app.instance('lens', recorder)
  app.instance('lens.entries', entries)
  app.instance('view', new JsxViewFactory())

  const read = { path: 'lens', enabled: true, watchers: {} as never }

  return {
    app,
    entries,
    recorder,
    api: new Elysia().use(lensRoutes(app, read)),
    dashboard: new Elysia().use(lensDashboard(app, read))
  }
}

describe('hasMonitoredTag', () => {
  /**
   * The property the whole feature exists for.
   *
   * A production filter keeps failures and drops the rest. This is how one
   * subject is exempted from that — and it is the line the published provider
   * stub carries, so it has to work for the stub to mean what Telescope's does.
   */
  test('an entry with a monitored tag survives a filter that drops everything', async () => {
    const { entries, recorder } = await stage()

    await entries.monitor(['auth:41'])
    await refreshMonitoring({ make: () => entries } as never, recorder)

    // The filter every production application ends up with, in miniature.
    recorder.filter((entry) => entry.isException() || entry.hasMonitoredTag())

    enterWorkContext()
    recorder.start()

    recorder.record(EntryType.QUERY, IncomingEntry.make({ sql: 'ordinary' }))
    recorder.record(EntryType.QUERY, IncomingEntry.make({ sql: 'watched' }).withTags(['auth:41']))

    await recorder.store(entries)

    const kept = await entries.get(EntryType.QUERY, new EntryQueryOptions())

    expect(kept).toHaveLength(1)
    expect(kept[0]?.content.sql).toBe('watched')
  })

  test('untagged entries and unmonitored tags answer false', () => {
    const bare = IncomingEntry.make({}).withMonitored(['auth:41'])
    const other = IncomingEntry.make({}).withTags(['auth:9']).withMonitored(['auth:41'])
    const none = IncomingEntry.make({}).withTags(['auth:41'])

    expect(bare.hasMonitoredTag()).toBe(false)
    expect(other.hasMonitoredTag()).toBe(false)
    expect(none.hasMonitoredTag()).toBe(false)
  })
})

describe('the monitoring API', () => {
  test('lists, adds and removes a tag', async () => {
    const { api, entries } = await stage()

    const empty = await (
      await api.handle(new Request('http://localhost/lens-api/monitored-tags'))
    ).json()

    expect(empty).toEqual({ tags: [] })

    const added = await api.handle(
      new Request('http://localhost/lens-api/monitored-tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'auth:41' })
      })
    )

    expect(added.status).toBe(204)
    expect(await entries.monitoring()).toEqual(['auth:41'])

    const removed = await api.handle(
      new Request('http://localhost/lens-api/monitored-tags/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'auth:41' })
      })
    )

    expect(removed.status).toBe(204)
    expect(await entries.monitoring()).toEqual([])
  })

  /** A blank tag would be stored forever and match nothing. */
  test('a blank tag is refused', async () => {
    const { api, entries } = await stage()

    const response = await api.handle(
      new Request('http://localhost/lens-api/monitored-tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: '   ' })
      })
    )

    expect(response.status).toBe(422)
    expect(await entries.monitoring()).toEqual([])
  })

  test('adding a tag refreshes what the recorder holds', async () => {
    const { api, recorder } = await stage()

    expect(recorder.monitoredTags()).toEqual([])

    await api.handle(
      new Request('http://localhost/lens-api/monitored-tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'auth:41' })
      })
    )

    expect(recorder.monitoredTags()).toEqual(['auth:41'])
  })

  test('every route is behind the gate', async () => {
    const { app, api } = await stage()

    app.make('lens').auth(() => false)

    for (const request of [
      new Request('http://localhost/lens-api/monitored-tags'),
      new Request('http://localhost/lens-api/monitored-tags', { method: 'POST' })
    ]) {
      expect((await api.handle(request)).status).toBe(403)
    }
  })
})

describe('the monitoring screen', () => {
  test('renders the tags being monitored', async () => {
    const { dashboard, entries } = await stage()

    await entries.monitor(['auth:41', 'User:9'])

    const body = await (
      await dashboard.handle(new Request('http://localhost/lens/monitoring'))
    ).text()

    expect(body).toContain('auth:41')
    expect(body).toContain('User:9')
    expect(body).toContain('_token')
  })

  test('says so when nothing is monitored', async () => {
    const { dashboard } = await stage()

    const body = await (
      await dashboard.handle(new Request('http://localhost/lens/monitoring'))
    ).text()

    expect(body).toContain('Nothing is being monitored')
  })

  test('the form adds a tag and sends you back', async () => {
    const { dashboard, entries } = await stage()

    const response = await dashboard.handle(
      new Request('http://localhost/lens/monitoring', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'tag=auth%3A41'
      })
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/lens/monitoring')
    expect(await entries.monitoring()).toEqual(['auth:41'])
  })

  test('and removes one', async () => {
    const { dashboard, entries } = await stage()

    await entries.monitor(['auth:41'])

    await dashboard.handle(
      new Request('http://localhost/lens/monitoring/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'tag=auth%3A41'
      })
    )

    expect(await entries.monitoring()).toEqual([])
  })

  /**
   * `monitoring` is not an entry type, so the type route must not claim it.
   */
  test('the type route does not swallow it', async () => {
    const { dashboard } = await stage()

    const response = await dashboard.handle(new Request('http://localhost/lens/monitoring'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
  })
})
