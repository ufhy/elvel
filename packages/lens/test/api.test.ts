import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { Elysia } from 'elysia'
import { IncomingEntry } from '../src/entry.ts'
import { EntryType, type EntryTypeName } from '../src/entry-type.ts'
import { lensRoutes } from '../src/http/routes.ts'
import { watcherStatus } from '../src/http/status.ts'
import { Recorder } from '../src/recorder.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'

async function api(options: { open?: boolean; watchers?: Record<string, unknown> } = {}) {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-api')
  app.config.set('database.connections.lens-api', { driver: 'sqlite', database: ':memory:' })

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
  if (options.open === true) recorder.auth(() => true)

  app.instance('lens', recorder)
  app.instance('lens.entries', entries)

  const router = new Elysia().use(
    lensRoutes(app, {
      path: 'lens',
      enabled: true,
      watchers: (options.watchers ?? {
        request: { enabled: true },
        query: { enabled: true }
      }) as never
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

describe('the gate', () => {
  /**
   * Closed by default, and this is the test that says so.
   *
   * Telescope's default is `local`, which is not copied: a server with an empty
   * `HOST` binds every interface, so "local" says nothing about who can reach
   * it. The spike's security review found exactly this open in local.
   */
  test('refuses everyone until an application says otherwise', async () => {
    const { router } = await api()

    const response = await router.handle(
      new Request('http://localhost/lens-api/query', { method: 'POST' })
    )

    expect(response.status).toBe(403)
  })

  test('lets a request through once auth allows it', async () => {
    const { router } = await api({ open: true })

    const response = await router.handle(
      new Request('http://localhost/lens-api/query', { method: 'POST' })
    )

    expect(response.status).toBe(200)
  })

  test('a gate that throws is a refusal, not a 500', async () => {
    const { router, recorder } = await api()

    recorder.auth(() => {
      throw new Error('gate exploded')
    })

    const response = await router.handle(
      new Request('http://localhost/lens-api/query', { method: 'POST' })
    )

    expect(response.status).toBe(403)
  })
})

describe('listing entries', () => {
  test('returns the entries of one type with the watcher status', async () => {
    const { router, entries } = await api({ open: true })

    await entries.store([entry(EntryType.QUERY, { sql: 'select 1' })])
    await entries.store([entry(EntryType.REQUEST, { method: 'GET' })])

    const response = await router.handle(
      new Request('http://localhost/lens-api/query', { method: 'POST' })
    )
    const body = (await response.json()) as { entries: unknown[]; status: string }

    expect(body.entries).toHaveLength(1)
    expect(body.status).toBe('enabled')
  })

  /**
   * Why the list is empty matters more than the empty list.
   *
   * A dashboard that cannot tell "switched off" from "nothing has happened"
   * sends people to read config files.
   */
  test('says off when the watcher is disabled', async () => {
    const { router } = await api({ open: true, watchers: { query: false } })

    const response = await router.handle(
      new Request('http://localhost/lens-api/query', { method: 'POST' })
    )

    expect(((await response.json()) as { status: string }).status).toBe('off')
  })

  test('a limit from the URL is clamped', async () => {
    const { router, entries } = await api({ open: true })

    for (let index = 0; index < 5; index++) {
      await entries.store([entry(EntryType.QUERY, { n: index })])
    }

    const response = await router.handle(
      new Request('http://localhost/lens-api/query?limit=2', { method: 'POST' })
    )

    expect(((await response.json()) as { entries: unknown[] }).entries).toHaveLength(2)
  })
})

describe('showing one entry', () => {
  /**
   * The batch travels with the entry, and this is the feature.
   *
   * An exception is worth little without the query that raised it and the
   * request that ran it, related by nothing but a shared batch.
   */
  test('carries every entry from the same batch', async () => {
    const { router, entries } = await api({ open: true })
    const subject = entry(EntryType.REQUEST, { method: 'GET' }, 'together')

    await entries.store([
      subject,
      entry(EntryType.QUERY, { sql: 'select 1' }, 'together'),
      entry(EntryType.QUERY, { sql: 'select 2' }, 'together'),
      entry(EntryType.QUERY, { sql: 'elsewhere' }, 'apart')
    ])

    const response = await router.handle(
      new Request(`http://localhost/lens-api/request/${subject.uuid}`)
    )
    const body = (await response.json()) as { entry: { id: string }; batch: unknown[] }

    expect(body.entry.id).toBe(subject.uuid)
    expect(body.batch).toHaveLength(3)
  })

  test('an unknown id is a 404, not a crash', async () => {
    const { router } = await api({ open: true })

    const response = await router.handle(
      new Request(`http://localhost/lens-api/request/${crypto.randomUUID()}`)
    )

    expect(response.status).toBe(404)
  })
})

describe('clearing', () => {
  test('deletes every entry', async () => {
    const { router, entries } = await api({ open: true })

    await entries.store([entry(EntryType.QUERY, { sql: 'select 1' })])

    const response = await router.handle(
      new Request('http://localhost/lens-api/entries', { method: 'DELETE' })
    )

    expect(response.status).toBe(204)
    expect(await entries.monitoring()).toEqual([])
  })

  test('is refused without the gate', async () => {
    const { router, entries } = await api()

    await entries.store([entry(EntryType.QUERY, { sql: 'select 1' })])

    const response = await router.handle(
      new Request('http://localhost/lens-api/entries', { method: 'DELETE' })
    )

    expect(response.status).toBe(403)
  })
})

describe('watcherStatus', () => {
  test('names the four reasons a list can be empty', () => {
    const lens = new Recorder()

    expect(watcherStatus(lens, false, { query: {} }, 'query')).toBe('disabled')
    expect(watcherStatus(lens, true, {}, 'query')).toBe('off')
    expect(watcherStatus(lens, true, { query: { enabled: false } }, 'query')).toBe('off')
    expect(watcherStatus(lens, true, { query: {} }, 'query')).toBe('enabled')

    lens.setPaused(true)

    expect(watcherStatus(lens, true, { query: {} }, 'query')).toBe('paused')
  })
})
