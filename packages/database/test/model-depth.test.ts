import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elysian/core'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

class Note extends Model {
  static override table = 'notes'
  // The table below has no created_at/updated_at, and the model must not invent
  // them: a write would name a column that is not there.
  static override timestamps = false

  declare id: number
  declare title: string
}

beforeEach(async () => {
  const app = new Application(process.cwd())

  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  await app.register(DatabaseServiceProvider)
  await app.boot()

  const connection = await app.make('db').connection()
  await connection.statement('create table notes (id integer primary key, title text)')
  await connection.statement("insert into notes values (1,'one'),(2,'two'),(3,'three')")
})

describe('destroy', () => {
  test('deletes the rows named and reports how many', async () => {
    expect(await Note.destroy([1, 2])).toBe(2)
    expect(await Note.query().count()).toBe(1)
  })

  test('takes a single key as well as a list', async () => {
    expect(await Note.destroy(1)).toBe(1)
  })

  test('an empty list touches nothing', async () => {
    expect(await Note.destroy([])).toBe(0)
    expect(await Note.query().count()).toBe(3)
  })

  test('counts what was deleted, not what was asked for', async () => {
    // Two of the three keys exist; the answer is two.
    expect(await Note.destroy([1, 99])).toBe(1)
  })

  /**
   * The reason it loads each row instead of one bulk delete.
   *
   * `delete where id in (…)` is one statement and fires no model events, so a
   * cache flush or an audit line written as a listener never runs. Laravel makes
   * the same trade for the same reason.
   */
  test('each row is deleted individually, so events can fire', async () => {
    const seen: number[] = []
    const original = Note.prototype.delete

    Note.prototype.delete = async function patched(this: Note) {
      seen.push(this.id)

      return original.call(this)
    }

    try {
      await Note.destroy([1, 2, 3])
    } finally {
      Note.prototype.delete = original
    }

    expect<number[]>(seen).toEqual([1, 2, 3])
  })
})

describe('saveOrFail and deleteOrFail', () => {
  test('hand the model back when the write worked', async () => {
    const note = (await Note.query().find(1)) as Note
    note.title = 'renamed'

    expect((await note.saveOrFail()).title).toBe('renamed')
    expect(await (await Note.query().find(1))?.title).toBe('renamed')
  })

  test('deleteOrFail removes the row', async () => {
    const note = (await Note.query().find(1)) as Note

    await note.deleteOrFail()

    // `find()` answers undefined rather than null when nothing matched.
    expect(await Note.query().find(1)).toBeUndefined()
  })

  /**
   * The failure `save()` reports quietly.
   *
   * A caller who forgets to check a false carries on as though the write landed.
   * This is for the paths where carrying on is worse than stopping.
   */
  test('deleteOrFail throws when there was nothing to delete', async () => {
    const note = (await Note.query().find(1)) as Note
    await note.delete()

    await expect(note.deleteOrFail()).rejects.toThrow(/Could not delete \[Note\]/)
  })
})

describe('route keys', () => {
  test('routeKeyName is the primary key unless the model says otherwise', () => {
    expect(Note.routeKeyName()).toBe('id')
  })

  test('resolveRouteBinding finds the row, or nothing', async () => {
    expect((await Note.resolveRouteBinding('2'))?.title).toBe('two')
    expect(await Note.resolveRouteBinding('99')).toBeUndefined()
  })
})
