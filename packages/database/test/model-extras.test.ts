import { beforeEach, describe, expect, test } from 'bun:test'
import { enterRequestContext, withoutRequestContext } from '@elvel/core'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { Model, newUniqueId } from '../src/model/model.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

class Note extends Model {
  static override table = 'notes'
  static override timestamps = false
  static override fillable = ['title', 'body']

  declare title: string
  declare body: string
}

class Ticket extends Model {
  static override table = 'tickets'
  static override timestamps = false
  static override fillable = ['subject']
  static override primaryKey = 'id'
  static override incrementing = false
  static override keyType = 'string' as const
  static override uniqueIds = 'ulid' as const

  declare subject: string
}

class Room extends Model {
  static override table = 'rooms'
  static override timestamps = false
  static override fillable = ['name']

  declare name: string

  override broadcastOn(event: string) {
    return event === 'deleted' ? undefined : `rooms.${this.getKey()}`
  }
}

let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  Model.setConnectionResolver(async () => connection)
  Model.setEventDispatcher(undefined)

  const schema = new SchemaBuilder(connection)

  await schema.create('notes', (table) => {
    table.id()
    table.string('title').unique()
    table.string('body').nullable()
  })
  await schema.create('tickets', (table) => {
    table.string('id').primary()
    table.string('subject')
  })
  await schema.create('rooms', (table) => {
    table.id()
    table.string('name')
  })
})

/** The half of firstOrCreate that writes nothing. */
describe('firstOrNew', () => {
  test('returns an unsaved model carrying what was searched for', async () => {
    const note = await Note.query().firstOrNew({ title: 'Draft' }, { body: 'text' })

    expect(note.exists).toBe(false)
    expect(note.title).toBe('Draft')
    expect(note.body).toBe('text')
    expect(await Note.query().count()).toBe(0)
  })

  test('and the existing row when there is one', async () => {
    await Note.create({ title: 'Draft', body: 'saved' })

    const note = await Note.query().firstOrNew({ title: 'Draft' }, { body: 'other' })

    expect(note.exists).toBe(true)
    expect(note.body).toBe('saved')
  })
})

describe('withOnly and without', () => {
  test('withOnly replaces whatever was already asked for', async () => {
    const query = Note.query().with('a').withOnly('b')

    expect(query.eagerLoaded()).toEqual(['b'])
  })

  test('without drops one, and its nested names with it', async () => {
    const query = Note.query().with('posts', 'posts.comments', 'tags').without('posts')

    expect(query.eagerLoaded()).toEqual(['tags'])
  })
})

/** A bulk write skipping them is how a table ends up half undated. */
describe('Model.upsert', () => {
  test('inserts and updates in one statement', async () => {
    await Note.create({ title: 'One', body: 'first' })

    const affected = await Note.upsert(
      [
        { title: 'One', body: 'changed' },
        { title: 'Two', body: 'new' }
      ],
      ['title'],
      ['body']
    )

    expect(affected).toBeGreaterThan(0)
    expect(await Note.query().count()).toBe(2)
    expect((await Note.query().where('title', 'One').first())?.body).toBe('changed')
  })

  test('and nothing is not a statement', async () => {
    expect(await Note.upsert([], ['title'])).toBe(0)
  })
})

/** A random UUID scatters inserts across the index; a ULID does not. */
describe('generated keys', () => {
  test('a ULID key is made here, not by the database', async () => {
    const ticket = await Ticket.create({ subject: 'Broken' })

    expect(typeof ticket.getKey()).toBe('string')
    expect(String(ticket.getKey())).toHaveLength(26)
    expect(await Ticket.query().find(ticket.getKey() as string)).toBeDefined()
  })

  test('and two made in order sort in order', () => {
    const first = newUniqueId('ulid')
    const second = newUniqueId('ulid')

    // The timestamp is the leading ten characters.
    expect(first.slice(0, 10) <= second.slice(0, 10)).toBe(true)
  })

  test('a uuid is a uuid', () => {
    expect(newUniqueId('uuid')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

/** No dependency on broadcasting: it already listens for anything with broadcastOn. */
describe('BroadcastsEvents', () => {
  test('a change is dispatched as a broadcastable event', async () => {
    const seen: Array<{ name: string; channel: unknown; event: unknown }> = []

    Model.setEventDispatcher({
      dispatch: async (name: string, payload: unknown) => {
        const event = payload as { broadcastOn?: () => unknown; broadcastAs?: () => unknown }

        if (event?.broadcastOn) {
          seen.push({ name, channel: event.broadcastOn(), event: event.broadcastAs?.() })
        }

        return []
      }
    } as never)

    const room = await Room.create({ name: 'Lobby' })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.channel).toBe(`rooms.${room.getKey()}`)
    expect(seen[0]?.event).toBe('RoomCreated')
  })

  /** A client told about a row that may never exist is worse than not told. */
  test('and only the three that mean something to a client', async () => {
    const names: string[] = []

    Model.setEventDispatcher({
      dispatch: async (name: string, payload: unknown) => {
        if ((payload as { broadcastOn?: unknown })?.broadcastOn) names.push(name)

        return []
      }
    } as never)

    const room = await Room.create({ name: 'Lobby' })
    await room.update({ name: 'Hall' })
    await room.delete()

    // `deleted` is refused by this model's own broadcastOn, which returns nothing.
    expect(names).toEqual(['model.broadcast.created', 'model.broadcast.updated'])
  })
})

/**
 * Hydrations belong to the unit of work that caused them.
 *
 * A single counter on the class was read by whichever request finished first:
 * measured on a playground page that calls its own server, the eight models the
 * page hydrated were reported against the inner call, because that one flushed
 * first. A process serving two requests at once scrambles them the same way.
 */
describe('counting hydrations', () => {
  test('two units of work do not take each other counts', async () => {
    await Note.create({ title: 'a' })
    await Note.create({ title: 'b' })

    enterRequestContext()

    const outer = await Note.query().get()

    expect(outer.count()).toBe(2)

    /**
     * A second unit of work, in a context of its own.
     *
     * `withoutRequestContext` is how a separate one is modelled here:
     * `enterWorkContext` uses `enterWith`, so a nested call in the *same* async
     * branch replaces the surrounding store rather than sitting beside it —
     * which is not what two requests off the event loop do.
     */
    const inner = await withoutRequestContext(async () => {
      enterRequestContext()

      await Note.query().get()

      return Model.takeHydratedCount()
    })

    expect(inner).toBeGreaterThan(0)
    // The outer count is still its own, not zeroed by the inner one.
    expect(Model.takeHydratedCount()).toBeGreaterThan(0)
  })

  test('and with no context at all it still counts', async () => {
    await Note.create({ title: 'a' })

    Model.takeHydratedCount()

    await Note.query().get()

    expect(Model.takeHydratedCount()).toBeGreaterThan(0)
  })
})
