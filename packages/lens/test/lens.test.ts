import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Application, enterWorkContext } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { callerFrom } from '../src/caller.ts'
import { isClearable, isPrunable, isTerminable } from '../src/contracts.ts'
import { IncomingEntry } from '../src/entry.ts'
import { EntryType, type EntryTypeName } from '../src/entry-type.ts'
import { EntryUpdate } from '../src/entry-update.ts'
import { Recorder } from '../src/recorder.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'
import { EntryQueryOptions } from '../src/storage/query-options.ts'
import { QueryWatcher } from '../src/watchers/query.ts'

/** A repository on its own in-memory database, with the tables the stub creates. */
async function open(): Promise<DatabaseEntriesRepository> {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-test')
  app.config.set('database.connections.lens-test', { driver: 'sqlite', database: ':memory:' })

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

  return new DatabaseEntriesRepository(db, { table: 'lens_entries' })
}

function entry(
  type: EntryTypeName = EntryType.QUERY,
  content: Record<string, unknown> = {}
): IncomingEntry {
  return IncomingEntry.make(content).withType(type).withBatch(crypto.randomUUID())
}

describe('storage', () => {
  test('stores an entry and reads it back by uuid', async () => {
    const repository = await open()
    const query = entry(EntryType.QUERY, { sql: 'select 1' }).withTags(['slow'])

    await repository.store([query])

    const found = await repository.find(query.uuid)

    expect(found?.uuid).toBe(query.uuid)
    expect(found?.content.sql).toBe('select 1')
    expect(found?.tags).toEqual(['slow'])
  })

  test('lists newest first and pages by sequence rather than offset', async () => {
    const repository = await open()

    for (let index = 0; index < 5; index++) {
      await repository.store([entry(EntryType.QUERY, { n: index })])
    }

    const options = new EntryQueryOptions()
    options.limit = 2

    const first = await repository.get(EntryType.QUERY, options)

    expect(first.map((result) => result.content.n)).toEqual([4, 3])

    const next = new EntryQueryOptions()
    next.limit = 2
    next.beforeSequence = first[1]?.sequence

    const second = await repository.get(EntryType.QUERY, next)

    expect(second.map((result) => result.content.n)).toEqual([2, 1])
  })

  /**
   * The behaviour that makes one repeated exception one row.
   *
   * Worth a test of its own because it is two facts that have to agree: storing
   * folds the earlier rows off the index, and the index query filters on the
   * flag while a family lookup does not.
   */
  test('collapses a repeated family on the index and expands it on lookup', async () => {
    const repository = await open()

    for (let index = 0; index < 3; index++) {
      await repository.store([
        entry(EntryType.EXCEPTION, { message: 'boom' }).withFamilyHash('same')
      ])
    }

    const index = await repository.get(EntryType.EXCEPTION, new EntryQueryOptions())

    expect(index).toHaveLength(1)
    expect(index[0]?.content.occurrences).toBe(3)

    const family = new EntryQueryOptions()
    family.familyHash = 'same'

    expect(await repository.get(EntryType.EXCEPTION, family)).toHaveLength(3)
  })

  test('finds entries by any of several tags', async () => {
    const repository = await open()

    await repository.store([entry(EntryType.QUERY, { n: 1 }).withTags(['slow'])])
    await repository.store([entry(EntryType.QUERY, { n: 2 }).withTags(['other'])])
    await repository.store([entry(EntryType.QUERY, { n: 3 })])

    const options = new EntryQueryOptions()
    options.tag = 'slow, other'

    const found = await repository.get(EntryType.QUERY, options)

    expect(found.map((result) => result.content.n).sort()).toEqual([1, 2])
  })

  test('reports patches whose row is not there yet instead of failing', async () => {
    const repository = await open()
    const stored = entry(EntryType.QUERY, { status: 'pending' })

    await repository.store([stored])

    const applied = new EntryUpdate(stored.uuid, EntryType.QUERY).change({ status: 'done' })
    const orphan = new EntryUpdate(crypto.randomUUID(), EntryType.QUERY).change({ status: 'x' })

    const pending = await repository.update([applied, orphan])

    expect(pending).toHaveLength(1)
    expect(pending[0]).toBe(orphan)
    expect((await repository.find(stored.uuid))?.content.status).toBe('done')
  })

  test('prunes by age and can keep exceptions', async () => {
    const repository = await open()
    const old = new Date(Date.now() - 48 * 3_600_000)

    await repository.store([
      new IncomingEntry({ n: 1 }, undefined, old).withType(EntryType.QUERY).withBatch('b'),
      new IncomingEntry({ n: 2 }, undefined, old)
        .withType(EntryType.EXCEPTION)
        .withBatch('b')
        .withFamilyHash('f')
    ])

    const pruned = await repository.prune(new Date(Date.now() - 3_600_000), true)

    expect(pruned).toBe(1)
    expect(await repository.get(EntryType.EXCEPTION, new EntryQueryOptions())).toHaveLength(1)
    expect(await repository.get(EntryType.QUERY, new EntryQueryOptions())).toHaveLength(0)
  })

  test('a tag is monitored until it is not, and the memo is dropped on write', async () => {
    const repository = await open()

    expect(await repository.isMonitoring(['urgent'])).toBe(false)

    await repository.monitor(['urgent'])

    expect(await repository.isMonitoring(['urgent', 'other'])).toBe(true)

    await repository.stopMonitoring(['urgent'])

    expect(await repository.isMonitoring(['urgent'])).toBe(false)
  })

  test('satisfies all four contracts', async () => {
    const repository = await open()

    expect(isClearable(repository)).toBe(true)
    expect(isPrunable(repository)).toBe(true)
    expect(isTerminable(repository)).toBe(true)
  })

  test('clear empties every table', async () => {
    const repository = await open()

    await repository.store([entry(EntryType.QUERY, { n: 1 }).withTags(['t'])])
    await repository.monitor(['t'])
    await repository.clear()

    expect(await repository.get(undefined, new EntryQueryOptions())).toHaveLength(0)
    expect(await repository.monitoring()).toEqual([])
  })
})

describe('recorder', () => {
  function recorder(): Recorder {
    const instance = new Recorder()
    instance.enable(true)

    return instance
  }

  test('records nothing until a batch is opened', () => {
    const lens = recorder()

    enterWorkContext()

    expect(lens.recording()).toBe(false)

    lens.start()

    expect(lens.recording()).toBe(true)
  })

  /**
   * The reason the batch is a slot and not a static.
   *
   * Two units of work run interleaved here, which under Bun is the ordinary
   * case. With a shared queue the second one's entry would land in the first
   * one's batch and the dashboard would show a request that ran a query it
   * never ran.
   */
  test('two units of work do not share a batch', async () => {
    const lens = recorder()
    const seen: Array<string | undefined> = []

    async function unit(label: string): Promise<void> {
      enterWorkContext()
      lens.start()

      const batch = lens.batchId()

      await Promise.resolve()

      lens.record(EntryType.QUERY, IncomingEntry.make({ label }))

      seen.push(batch)

      const repository = await open()
      await lens.store(repository)

      const stored = await repository.get(EntryType.QUERY, new EntryQueryOptions())

      expect(stored).toHaveLength(1)
      expect(stored[0]?.content.label).toBe(label)
      expect(stored[0]?.batchId).toBe(batch)
    }

    await Promise.all([unit('one'), unit('two')])

    expect(new Set(seen).size).toBe(2)
  })

  /**
   * The bug that broke the spike this package came from.
   *
   * Storing runs inserts, and inserts emit the event the query watcher listens
   * for. Without suppression the recorder grows an entry for every entry it
   * writes and never stops.
   */
  test('suppresses recording while it stores', async () => {
    const lens = recorder()
    const repository = await open()

    enterWorkContext()
    lens.start()

    let recordingDuringStore: boolean | undefined

    lens.afterStoring(() => {
      recordingDuringStore = lens.recording()
    })

    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'select 1' }))

    await lens.store(repository)

    expect(recordingDuringStore).toBe(false)
  })

  test('withoutRecording nests and restores', () => {
    const lens = recorder()

    enterWorkContext()
    lens.start()

    lens.withoutRecording(() => {
      lens.withoutRecording(() => {
        expect(lens.recording()).toBe(false)
      })

      expect(lens.recording()).toBe(false)
    })

    expect(lens.recording()).toBe(true)
  })

  test('a filter that throws does not lose the entry path', async () => {
    const lens = recorder()
    const repository = await open()

    enterWorkContext()
    lens.start()

    lens.filter(() => {
      throw new Error('broken filter')
    })

    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'select 1' }))

    await lens.store(repository)

    expect(await repository.get(EntryType.QUERY, new EntryQueryOptions())).toHaveLength(0)
  })

  test('every filter must agree', async () => {
    const lens = recorder()
    const repository = await open()

    enterWorkContext()
    lens.start()

    lens.filter((candidate) => candidate.isQuery())
    lens.filter((candidate) => candidate.content.keep === true)

    lens.record(EntryType.QUERY, IncomingEntry.make({ keep: true }))
    lens.record(EntryType.QUERY, IncomingEntry.make({ keep: false }))

    await lens.store(repository)

    const stored = await repository.get(EntryType.QUERY, new EntryQueryOptions())

    expect(stored).toHaveLength(1)
    expect(stored[0]?.content.keep).toBe(true)
  })

  test('tag callbacks apply to every entry', async () => {
    const lens = recorder()
    const repository = await open()

    enterWorkContext()
    lens.start()

    lens.tag(() => ['everywhere'])
    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'select 1' }))

    await lens.store(repository)

    const options = new EntryQueryOptions()
    options.tag = 'everywhere'

    expect(await repository.get(EntryType.QUERY, options)).toHaveLength(1)
  })

  test('a second flush of the same batch stores nothing twice', async () => {
    const lens = recorder()
    const repository = await open()

    enterWorkContext()
    lens.start()

    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'select 1' }))

    await lens.store(repository)
    await lens.store(repository)

    expect(await repository.get(EntryType.QUERY, new EntryQueryOptions())).toHaveLength(1)
  })

  /**
   * A recorder that can fail the request it was watching is worse than none —
   * the spike lost a server to an unhandled rejection from its own write.
   */
  test('a storage failure is reported, not thrown', async () => {
    const failures: unknown[] = []
    const lens = new Recorder((error) => failures.push(error))
    lens.enable(true)

    enterWorkContext()
    lens.start()
    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'select 1' }))

    await lens.store({
      store: () => Promise.reject(new Error('disk on fire')),
      update: () => Promise.resolve([]),
      find: () => Promise.resolve(undefined),
      get: () => Promise.resolve([]),
      count: () => Promise.resolve(0),
      monitoring: () => Promise.resolve([]),
      isMonitoring: () => Promise.resolve(false),
      monitor: () => Promise.resolve(),
      stopMonitoring: () => Promise.resolve()
    })

    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe('disk on fire')
  })

  test('recording is off entirely when the recorder is disabled', () => {
    const lens = new Recorder()

    enterWorkContext()

    expect(lens.start()).toBeUndefined()
    expect(lens.recording()).toBe(false)
  })
})

describe('caller', () => {
  /** The framework's own source is resolved, so the frame here is a real path. */
  const frameworkFrame = resolve(import.meta.dir, '..', 'src', 'watchers', 'query.ts')

  test('skips framework frames and returns the first application one', () => {
    const stack = [
      'Error',
      '    at query (/app/node_modules/pg/lib/client.js:12:3)',
      `    at run (${frameworkFrame}:40:9)`,
      '    at handler (/app/routes/web.ts:17:5)',
      '    at serve (/app/node_modules/elysia/dist/index.js:9:1)'
    ].join('\n')

    expect(callerFrom(stack)).toEqual({ file: '/app/routes/web.ts', line: 17 })
  })

  /**
   * The reason the rule resolves a directory instead of matching `packages/`.
   *
   * An application with its own monorepo has frames under its own `packages/`,
   * and those are exactly the ones worth reporting.
   */
  test("but an application's own packages are not framework frames", () => {
    const stack = 'Error\n    at h (/app/packages/web/src/routes.ts:12:1)'

    expect(callerFrom(stack)).toEqual({ file: '/app/packages/web/src/routes.ts', line: 12 })
  })

  /** A watcher's own test is the caller asking, not the framework answering. */
  test('and a frame in the framework tests is kept', () => {
    const inTest = resolve(import.meta.dir, 'lens.test.ts')

    expect(callerFrom(`Error\n    at t (${inTest}:1:1)`)).toEqual({ file: inTest, line: 1 })
  })

  test('reads a frame with no function name', () => {
    expect(callerFrom('Error\n    at /app/routes/web.ts:3:1')).toEqual({
      file: '/app/routes/web.ts',
      line: 3
    })
  })

  test('honours extra ignored paths', () => {
    const stack = 'Error\n    at q (/app/support/db.ts:5:1)\n    at h (/app/routes/web.ts:9:1)'

    expect(callerFrom(stack, ['/app/support/'])).toEqual({
      file: '/app/routes/web.ts',
      line: 9
    })
  })

  test('nothing but framework frames means no caller', () => {
    expect(callerFrom('Error\n    at x (/app/node_modules/pg/lib/client.js:1:1)')).toBeUndefined()
  })

  test('no stack at all is not an error', () => {
    expect(callerFrom(undefined)).toBeUndefined()
  })
})

describe('query options', () => {
  test('clamps a limit the URL asked for', () => {
    expect(EntryQueryOptions.fromRequest({ limit: '100000' }).limit).toBe(
      EntryQueryOptions.maxLimit
    )
    expect(EntryQueryOptions.fromRequest({ limit: '-4' }).limit).toBe(50)
    expect(EntryQueryOptions.fromRequest({ limit: 'nonsense' }).limit).toBe(50)
    expect(EntryQueryOptions.fromRequest({ limit: '10' }).limit).toBe(10)
  })

  test('splits and trims tags', () => {
    expect(EntryQueryOptions.fromRequest({ tag: ' a , b ,, ' }).tags()).toEqual(['a', 'b'])
  })

  test('an unfiltered list hides collapsed rows and a filtered one does not', () => {
    expect(EntryQueryOptions.fromRequest({}).showsCollapsed()).toBe(false)
    expect(EntryQueryOptions.fromRequest({ familyHash: 'x' }).showsCollapsed()).toBe(true)
  })
})

describe('entry', () => {
  test('predicates read the type and the content, not the caller', () => {
    expect(entry(EntryType.QUERY, { slow: true }).isSlowQuery()).toBe(true)
    expect(entry(EntryType.QUERY, {}).isSlowQuery()).toBe(false)
    expect(entry(EntryType.REQUEST, { responseStatus: 500 }).isFailedRequest()).toBe(true)
    expect(entry(EntryType.REQUEST, { responseStatus: 404 }).isFailedRequest()).toBe(false)
    expect(entry(EntryType.JOB, { status: 'failed' }).isFailedJob()).toBe(true)
  })

  test('a user contributes three fields and a tag, never the whole record', () => {
    const recorded = entry().withUser({
      id: 7,
      name: 'Ada',
      email: 'ada@example.test',
      password: 'secret'
    } as never)

    expect(recorded.content.user).toEqual({ id: 7, name: 'Ada', email: 'ada@example.test' })
    expect(JSON.stringify(recorded.content)).not.toContain('secret')
    expect(recorded.tags).toContain('auth:7')
  })

  test('tags stay unique', () => {
    expect(entry().withTags(['a', 'b']).withTags(['b', 'c']).tags).toEqual(['a', 'b', 'c'])
  })
})

describe('query watcher', () => {
  /**
   * The values a statement carried must not reach a row anyone with the
   * dashboard can read.
   *
   * Guarded rather than left to the comment above the field: the spike's
   * security review found exactly this leak, where a docstring warned about
   * objects and then let every primitive through. A test is what keeps the
   * decision from being undone by a well-meaning "the dashboard would be more
   * useful if you could see the parameters".
   */
  test('records how many bindings there were, never what they held', () => {
    const watcher = new QueryWatcher({ slow: 100 })
    const recorded: IncomingEntry[] = []

    const lens = {
      recording: () => true,
      record: (_type: EntryTypeName, candidate: IncomingEntry) => recorded.push(candidate)
    } as unknown as Recorder

    const reach = watcher as unknown as {
      record(lens: Recorder, event: unknown): void
    }

    reach.record(lens, {
      sql: 'select * from users where email = ? and token = ?',
      bindings: ['ada@example.test', 'sekrit-token'],
      time: 1.5,
      connectionName: 'main'
    })

    expect(recorded).toHaveLength(1)

    const serialised = JSON.stringify(recorded[0]?.content)

    expect(serialised).not.toContain('ada@example.test')
    expect(serialised).not.toContain('sekrit-token')
    expect(recorded[0]?.content.bindings).toBe(2)
    expect(recorded[0]?.content.sql).toContain('?')
  })

  test('the family hash ignores bindings so repeats collapse', () => {
    expect(QueryWatcher.familyHash('select * from users where id = ?')).toBe(
      QueryWatcher.familyHash('select * from users where id = ?')
    )
    expect(QueryWatcher.familyHash('select 1')).not.toBe(QueryWatcher.familyHash('select 2'))
  })
})

describe('filterBatch', () => {
  /**
   * The difference that decides whether the tool is any use in production.
   *
   * Per-entry filtering keeps the exception and drops the queries that caused
   * it — a failure with the reason removed, and an empty timeline on the one
   * page somebody opened it for. Telescope's documentation reaches for this
   * shape for exactly that reason.
   */
  test('keeps everything in a unit of work when anything in it qualifies', async () => {
    const repository = await open()
    const lens = new Recorder()

    lens.enable(true)
    lens.filterBatch((entries) => entries.some((candidate) => candidate.isException()))

    enterWorkContext()
    lens.start()

    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'the cause' }))
    lens.record(EntryType.CACHE, IncomingEntry.make({ key: 'also kept' }))
    lens.record(EntryType.EXCEPTION, IncomingEntry.make({ message: 'boom' }))

    await lens.store(repository)

    expect(await repository.get(undefined, new EntryQueryOptions())).toHaveLength(3)
  })

  test('and drops all of it when nothing does', async () => {
    const repository = await open()
    const lens = new Recorder()

    lens.enable(true)
    lens.filterBatch((entries) => entries.some((candidate) => candidate.isException()))

    enterWorkContext()
    lens.start()

    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'ordinary' }))
    lens.record(EntryType.CACHE, IncomingEntry.make({ key: 'ordinary' }))

    await lens.store(repository)

    expect(await repository.get(undefined, new EntryQueryOptions())).toHaveLength(0)
  })

  test('every registered filter has to agree', async () => {
    const repository = await open()
    const lens = new Recorder()

    lens.enable(true)
    lens.filterBatch(() => true)
    lens.filterBatch(() => false)

    enterWorkContext()
    lens.start()
    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'x' }))
    await lens.store(repository)

    expect(await repository.get(undefined, new EntryQueryOptions())).toHaveLength(0)
  })

  /**
   * A broken predicate must not silently empty the recorder — that is the
   * failure nobody would think to look for.
   */
  test('a filter that throws refuses nothing', async () => {
    const repository = await open()
    const failures: unknown[] = []
    const lens = new Recorder((error) => failures.push(error))

    lens.enable(true)
    lens.filterBatch(() => {
      throw new Error('broken batch filter')
    })

    enterWorkContext()
    lens.start()
    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'x' }))
    await lens.store(repository)

    expect(await repository.get(undefined, new EntryQueryOptions())).toHaveLength(1)
    expect(failures).toHaveLength(1)
  })

  /** A patch is about a row somebody else already decided to keep. */
  test('a refused batch still applies its patches', async () => {
    const repository = await open()
    const stored = entry(EntryType.JOB, { status: 'pending' })

    await repository.store([stored])

    const lens = new Recorder()

    lens.enable(true)
    lens.filterBatch(() => false)

    enterWorkContext()
    lens.start()
    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'dropped' }))
    lens.recordUpdate(new EntryUpdate(stored.uuid, EntryType.JOB).change({ status: 'processed' }))

    await lens.store(repository)

    expect((await repository.find(stored.uuid))?.content.status).toBe('processed')
    expect(await repository.get(EntryType.QUERY, new EntryQueryOptions())).toHaveLength(0)
  })
})
