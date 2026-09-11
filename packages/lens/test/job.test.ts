import { describe, expect, test } from 'bun:test'
import { Application, enterWorkContext } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { Dispatcher } from '@elvel/events'
import { EntryType } from '../src/entry-type.ts'
import { flushCommandBatches, openCommandBatches } from '../src/queue/command.ts'
import { flushJobBatches, openJobBatches } from '../src/queue/listener.ts'
import { Recorder } from '../src/recorder.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'
import { EntryQueryOptions } from '../src/storage/query-options.ts'
import { CommandWatcher } from '../src/watchers/command.ts'
import { JobWatcher } from '../src/watchers/job.ts'

async function stage() {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-job')
  app.config.set('database.connections.lens-job', { driver: 'sqlite', database: ':memory:' })

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

  app.instance('events', new Dispatcher())
  app.instance('lens', recorder)
  app.instance('lens.entries', entries)

  return { app, events: app.make('events'), entries, recorder }
}

const QUEUED = {
  job: 'SendInvoice',
  uuid: 'job-uuid-1',
  connection: 'redis',
  queue: 'mail',
  delay: 0,
  payload: { maxTries: 3, timeout: 60, data: { invoiceId: 9, secret: 'do-not-record' } }
}

describe('the job watcher', () => {
  test('records a job when it is dispatched, as pending', async () => {
    const { app, events, entries, recorder } = await stage()

    new JobWatcher({}).register(app)
    enterWorkContext()
    recorder.start()

    await events.dispatch('queue.job.queued', QUEUED)
    await recorder.store(entries)

    const found = await entries.get(EntryType.JOB, new EntryQueryOptions())

    expect(found).toHaveLength(1)
    expect(found[0]?.uuid).toBe('job-uuid-1')
    expect(found[0]?.content.status).toBe('pending')
    expect(found[0]?.content.queue).toBe('mail')
    expect(found[0]?.content.tries).toBe(3)
  })

  /**
   * The constructor data is counted, not kept.
   *
   * It is the field most likely to hold an email address, a token or a whole
   * model — the same trade the query watcher makes with bindings.
   */
  test('does not record what the job was constructed with', async () => {
    const { app, events, entries, recorder } = await stage()

    new JobWatcher({}).register(app)
    enterWorkContext()
    recorder.start()

    await events.dispatch('queue.job.queued', QUEUED)
    await recorder.store(entries)

    const found = await entries.get(EntryType.JOB, new EntryQueryOptions())

    expect(found[0]?.content.data).toBe(2)
    expect(JSON.stringify(found[0]?.content)).not.toContain('do-not-record')
  })

  /**
   * The update channel, exercised end to end for the first time.
   *
   * Nothing produced an `EntryUpdate` until this watcher existed: the storage,
   * the pending-update report and the retry were all built and tested against
   * hand-made updates.
   */
  test('patches the entry when the worker finishes it', async () => {
    const { app, events, entries, recorder } = await stage()

    new JobWatcher({}).register(app)

    // The dispatching unit of work.
    enterWorkContext()
    recorder.start()
    await events.dispatch('queue.job.queued', QUEUED)
    await recorder.store(entries)

    // The worker's, later and elsewhere.
    enterWorkContext()
    recorder.start()
    await events.dispatch('queue.job.processed', {
      job: 'SendInvoice',
      uuid: 'job-uuid-1',
      attempts: 1
    })
    await recorder.store(entries)

    const found = await entries.find('job-uuid-1')

    expect(found?.content.status).toBe('processed')
    expect(found?.content.attempts).toBe(1)
  })

  test('a failure is patched with its message and tagged', async () => {
    const { app, events, entries, recorder } = await stage()

    new JobWatcher({}).register(app)

    enterWorkContext()
    recorder.start()
    await events.dispatch('queue.job.queued', QUEUED)
    await recorder.store(entries)

    enterWorkContext()
    recorder.start()
    await events.dispatch('queue.job.failed', {
      job: 'SendInvoice',
      uuid: 'job-uuid-1',
      attempts: 3,
      error: new Error('smtp refused')
    })
    await recorder.store(entries)

    const found = await entries.find('job-uuid-1')

    expect(found?.content.status).toBe('failed')
    expect(found?.content.error).toBe('smtp refused')
    expect(found?.tags).toContain('failed')
  })

  /**
   * A patch arriving before its row is normal, not an error.
   *
   * A fast job finishes before the request that dispatched it has flushed — the
   * whole reason the channel reports pending updates instead of failing.
   */
  test('a patch for a row that is not there yet is reported, not lost', async () => {
    const { app, events, entries, recorder } = await stage()
    const failures: unknown[] = []
    const reporting = new Recorder((error) => failures.push(error))

    reporting.enable(true)
    app.instance('lens', reporting)
    new JobWatcher({}).register(app)

    enterWorkContext()
    reporting.start()
    await events.dispatch('queue.job.processed', { job: 'X', uuid: 'never-stored', attempts: 1 })
    await reporting.store(entries)

    expect(failures).toHaveLength(1)
    expect(String((failures[0] as Error).message)).toContain('found no row')
  })

  test('an event with no uuid is ignored rather than recorded half-formed', async () => {
    const { app, events, entries, recorder } = await stage()

    new JobWatcher({}).register(app)
    enterWorkContext()
    recorder.start()

    await events.dispatch('queue.job.queued', { job: 'X' })
    await recorder.store(entries)

    expect(await entries.get(EntryType.JOB, new EntryQueryOptions())).toHaveLength(0)
  })
})

describe('the command watcher', () => {
  test('records a command with its exit code and duration', async () => {
    const { app, events, entries } = await stage()

    openCommandBatches(app)
    new CommandWatcher({}).register(app)
    flushCommandBatches(app)

    enterWorkContext()
    await events.dispatch('command.starting', { command: 'migrate', arguments: ['--force'] })
    await events.dispatch('command.finished', {
      command: 'migrate',
      exitCode: 0,
      durationMs: 42
    })

    const found = await entries.get(EntryType.COMMAND, new EntryQueryOptions())

    expect(found).toHaveLength(1)
    expect(found[0]?.content.command).toBe('migrate')
    expect(found[0]?.content.status).toBe('ok')
    expect(found[0]?.content.duration).toBe(42)
  })

  test('a non-zero exit is failed and tagged', async () => {
    const { app, events, entries } = await stage()

    openCommandBatches(app)
    new CommandWatcher({}).register(app)
    flushCommandBatches(app)

    enterWorkContext()
    await events.dispatch('command.starting', { command: 'migrate' })
    await events.dispatch('command.finished', { command: 'migrate', exitCode: 1 })

    const found = await entries.get(EntryType.COMMAND, new EntryQueryOptions())

    expect(found[0]?.content.status).toBe('failed')
  })

  /**
   * A command that never ends never flushes, so recording the attempt only fills
   * the list with rows that say nothing.
   */
  test('an ignored command is skipped', async () => {
    const { app, events, entries } = await stage()

    openCommandBatches(app)
    new CommandWatcher({ ignore: ['queue:*', 'serve'] }).register(app)
    flushCommandBatches(app)

    enterWorkContext()
    await events.dispatch('command.starting', { command: 'queue:work' })
    await events.dispatch('command.finished', { command: 'queue:work', exitCode: 0 })

    expect(await entries.get(EntryType.COMMAND, new EntryQueryOptions())).toHaveLength(0)
  })

  test("a command's own work lands in its batch", async () => {
    const { app, events, entries } = await stage()

    openCommandBatches(app)
    new CommandWatcher({}).register(app)
    flushCommandBatches(app)

    enterWorkContext()
    await events.dispatch('command.starting', { command: 'migrate' })
    await events.dispatch('command.finished', { command: 'migrate', exitCode: 0 })

    const found = await entries.get(EntryType.COMMAND, new EntryQueryOptions())
    const batch = new EntryQueryOptions()
    batch.batchId = found[0]?.batchId

    expect((await entries.get(undefined, batch)).length).toBeGreaterThan(0)
  })
})

describe('the ordering both listener pairs depend on', () => {
  /**
   * Found by running a real worker, not by reading.
   *
   * `flushJobBatches` and `JobWatcher` subscribe to the same terminal events.
   * With the flush registered first it stored an empty batch, marked it flushed,
   * and the patch that arrived a moment later went nowhere — the job stayed
   * `pending` forever while `queue:work` reported success. Silent, and only
   * visible in the dashboard.
   */
  test('a job patch is lost when the flush is registered before the watcher', async () => {
    const { app, events, entries, recorder } = await stage()

    openJobBatches(app)
    // The mistake under test: flush before the watcher.
    flushJobBatches(app)
    new JobWatcher({}).register(app)

    enterWorkContext()
    recorder.start()
    await events.dispatch('queue.job.queued', QUEUED)
    await recorder.store(entries)

    enterWorkContext()
    await events.dispatch('queue.job.processing', { job: 'SendInvoice', uuid: 'job-uuid-1' })
    await events.dispatch('queue.job.processed', {
      job: 'SendInvoice',
      uuid: 'job-uuid-1',
      attempts: 1
    })

    expect((await entries.find('job-uuid-1'))?.content.status).toBe('pending')
  })

  test('and lands when the watcher comes first', async () => {
    const { app, events, entries, recorder } = await stage()

    openJobBatches(app)
    new JobWatcher({}).register(app)
    flushJobBatches(app)

    enterWorkContext()
    recorder.start()
    await events.dispatch('queue.job.queued', QUEUED)
    await recorder.store(entries)

    enterWorkContext()
    await events.dispatch('queue.job.processing', { job: 'SendInvoice', uuid: 'job-uuid-1' })
    await events.dispatch('queue.job.processed', {
      job: 'SendInvoice',
      uuid: 'job-uuid-1',
      attempts: 1
    })

    expect((await entries.find('job-uuid-1'))?.content.status).toBe('processed')
  })
})
