import { beforeEach, describe, expect, test } from 'bun:test'
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
