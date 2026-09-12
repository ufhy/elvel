import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { knowsBatches } from '../src/contracts.ts'
import { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'
import { NullEntriesRepository } from '../src/storage/null-repository.ts'

async function open(): Promise<DatabaseEntriesRepository> {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-batches')
  app.config.set('database.connections.lens-batches', { driver: 'sqlite', database: ':memory:' })

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

/**
 * A batch of entries sharing one id, the way a unit of work is stored.
 */
function unit(batchId: string, types: string[]): IncomingEntry[] {
  return types.map((type) =>
    IncomingEntry.make({ n: 1 })
      .withType(type as never)
      .withBatch(batchId)
  )
}

describe('recent batches', () => {
  /**
   * The bar's only window onto other processes. `bun elvel dev` runs the queue
   * worker beside the server, and a job's batch is flushed from the worker's own
   * memory — so without this the bar can never show a job.
   */
  test('groups stored rows back into units of work, newest first', async () => {
    const repository = await open()

    await repository.store(unit('first', [EntryType.REQUEST, EntryType.QUERY]))
    await repository.store(unit('second', [EntryType.JOB, EntryType.QUERY, EntryType.QUERY]))

    const batches = await repository.recentBatches(10)

    expect(batches.map((batch) => batch.batchId)).toEqual(['second', 'first'])
    expect(batches[0]).toMatchObject({ count: 3, types: { job: 1, query: 2 } })
  })

  test('honours the limit it is given', async () => {
    const repository = await open()

    for (const id of ['a', 'b', 'c']) await repository.store(unit(id, [EntryType.REQUEST]))

    expect((await repository.recentBatches(2)).map((batch) => batch.batchId)).toEqual(['c', 'b'])
  })

  test('an empty table is an empty list, not a failure', async () => {
    expect(await (await open()).recentBatches(10)).toEqual([])
  })

  /**
   * The contract is optional on purpose, following the four already in
   * `contracts.ts`: a driver that cannot group by batch does not implement it,
   * and the bar shows what it has rather than calling a stub.
   */
  test('the guard tells the two drivers apart', async () => {
    expect(knowsBatches(await open())).toBe(true)
    expect(knowsBatches(new NullEntriesRepository())).toBe(false)
  })
})
