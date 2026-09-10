import { describe, expect, test } from 'bun:test'
import { Application, enterWorkContext } from '@elvel/core'
import { ConnectionManager, QueryExecuted } from '@elvel/database'
import { EventServiceProvider } from '@elvel/events'
import { MessageLogged } from '@elvel/log'
import { EntryType } from '../src/entry-type.ts'
import { listenForJobs } from '../src/queue/listener.ts'
import { Recorder } from '../src/recorder.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'
import { EntryQueryOptions } from '../src/storage/query-options.ts'
import { EventWatcher } from '../src/watchers/event.ts'
import { ExceptionWatcher } from '../src/watchers/exception.ts'
import { QueryWatcher } from '../src/watchers/query.ts'

async function worker() {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-queue')
  app.config.set('database.connections.lens-queue', { driver: 'sqlite', database: ':memory:' })

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

  await new EventServiceProvider(app).register()

  const events = app.make('events')

  listenForJobs(app)
  new QueryWatcher({}).register(app)
  new ExceptionWatcher({}).register(app)

  return { app, events, entries, recorder }
}

/**
 * One job, driven through the events `Worker.process()` dispatches.
 *
 * `enterWorkContext()` first, because the worker calls it before dispatching
 * `queue.job.processing` — that is what gives each job a context of its own, and
 * without it this test would be exercising a shape the worker never produces.
 */
async function runJob(
  events: { dispatch(event: string | object, payload?: unknown): Promise<unknown> },
  body: () => Promise<void> | void,
  outcome = 'queue.job.processed'
): Promise<void> {
  enterWorkContext()

  await events.dispatch('queue.job.processing', { job: 'SendInvoice', attempts: 1 })
  await body()
  await events.dispatch(outcome, { job: 'SendInvoice', attempts: 1 })
}

describe('a queued job', () => {
  /**
   * Without the queue listener this is zero: a job's work reaches a recorder
   * with no open batch and every entry is dropped.
   */
  test('records what it does into a batch of its own', async () => {
    const { events, entries } = await worker()

    await runJob(events, async () => {
      await events.dispatch(new QueryExecuted('select 1', [], 1.5, 'main'))
    })

    const found = await entries.get(EntryType.QUERY, new EntryQueryOptions())

    expect(found).toHaveLength(1)
    expect(found[0]?.content.sql).toBe('select 1')
  })

  test('flushes on a failure as well as on success', async () => {
    const { events, entries } = await worker()

    await runJob(
      events,
      async () => {
        await events.dispatch(new QueryExecuted('select 2', [], 1, 'main'))
      },
      'queue.job.failed'
    )

    expect(await entries.get(EntryType.QUERY, new EntryQueryOptions())).toHaveLength(1)
  })

  test('and on a release', async () => {
    const { events, entries } = await worker()

    await runJob(
      events,
      async () => {
        await events.dispatch(new QueryExecuted('select 3', [], 1, 'main'))
      },
      'queue.job.released'
    )

    expect(await entries.get(EntryType.QUERY, new EntryQueryOptions())).toHaveLength(1)
  })

  /**
   * The property the request path needed too, for the same reason: two units of
   * work must not share a batch.
   */
  test('two jobs do not share a batch', async () => {
    const { events, entries } = await worker()

    await runJob(events, async () => {
      await events.dispatch(new QueryExecuted('first', [], 1, 'main'))
    })
    await runJob(events, async () => {
      await events.dispatch(new QueryExecuted('second', [], 1, 'main'))
    })

    const found = await entries.get(EntryType.QUERY, new EntryQueryOptions())

    expect(found).toHaveLength(2)
    expect(new Set(found.map((entry) => entry.batchId)).size).toBe(2)
  })

  test('an exception reported by a job is recorded too', async () => {
    const { events, entries } = await worker()
    const error = new Error('job broke')

    await runJob(
      events,
      async () => {
        await events.dispatch(
          new MessageLogged(
            'error',
            'job broke',
            { exception: 'Error', stack: error.stack },
            'stack'
          )
        )
      },
      'queue.job.failed'
    )

    const found = await entries.get(EntryType.EXCEPTION, new EntryQueryOptions())

    expect(found).toHaveLength(1)
    expect(found[0]?.content.message).toBe('job broke')
  })

  test('nothing is recorded outside a job', async () => {
    const { events, entries } = await worker()

    enterWorkContext()
    await events.dispatch(new QueryExecuted('orphan', [], 1, 'main'))

    expect(await entries.get(EntryType.QUERY, new EntryQueryOptions())).toHaveLength(0)
  })
})

describe('the event watcher beside the others', () => {
  /**
   * What the framework ignore list is actually for.
   *
   * Not the storage feedback loop — that is closed by `withoutRecording` around
   * the flush, and a test written to demonstrate a loop here passed with the
   * list switched off, which is how this correction was found. The list exists
   * to stop **double recording**: a query the application runs is already a
   * `query` entry, and a wildcard listener would file the same statement as an
   * `event` row beside it.
   */
  test('a framework event is recorded by its own watcher only', async () => {
    const { app, events, entries, recorder } = await worker()

    new EventWatcher({}).register(app)

    enterWorkContext()
    recorder.start()

    // Dispatched during the batch, not during the flush, so nothing is
    // suppressed and both watchers are given the chance.
    await events.dispatch(new QueryExecuted('select 1', [], 1, 'main'))
    await events.dispatch('order.placed', { id: 1 })

    await recorder.store(entries)

    const queries = await entries.get(EntryType.QUERY, new EntryQueryOptions())
    const recorded = await entries.get(EntryType.EVENT, new EntryQueryOptions())

    expect(queries).toHaveLength(1)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.content.name).toBe('order.placed')
  })
})
