import { beforeEach, describe, expect, test } from 'bun:test'
import { Collection } from '@elvel/support'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { ModelCollection } from '../src/model/collection.ts'
import { Model } from '../src/model/model.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

class Shop extends Model {
  static override table = 'shops'
  static override timestamps = false
  static override fillable = ['name', 'secret']
  static override hidden = ['secret']

  declare name: string
  declare secret: string

  items() {
    return this.hasMany(Item, 'shop_id')
  }

  /** `shouty` — the convention the serialiser looks for. */
  getShoutyAttribute(): string {
    return this.name.toUpperCase()
  }
}

class Item extends Model {
  static override table = 'items'
  static override timestamps = false
  static override fillable = ['shop_id', 'label']

  declare shop_id: number
  declare label: string
}

let connection: BunSqlConnection
let queries: string[]
let capturing = false

beforeEach(async () => {
  capturing = false
  queries = []

  // The dispatcher is fixed at construction, so capture is a flag rather than a
  // listener attached later.
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' }, {
    dispatch: async (event: unknown) => {
      if (capturing) queries.push((event as { sql: string }).sql)

      return []
    }
  } as never)
  Model.setConnectionResolver(async () => connection)
  Model.setEventDispatcher(undefined)

  const schema = new SchemaBuilder(connection)

  await schema.create('shops', (table) => {
    table.id()
    table.string('name')
    table.string('secret').nullable()
  })
  await schema.create('items', (table) => {
    table.id()
    table.integer('shop_id')
    table.string('label')
  })

  const first = await Shop.create({ name: 'One', secret: 'a' })
  const second = await Shop.create({ name: 'Two', secret: 'b' })

  await Item.create({ shop_id: first.getKey() as number, label: 'x' })
  await Item.create({ shop_id: second.getKey() as number, label: 'y' })

  queries = []
})

/** Having fetched a set and then found you need a relation. */
describe('load', () => {
  test('fetches a relation for models already in hand, in one query', async () => {
    const shops = await Shop.query().get()

    expect(shops).toBeInstanceOf(ModelCollection)
    expect(shops.first()?.relationLoaded('items')).toBe(false)

    capturing = true

    await shops.load('items')

    expect(shops.first()?.relationLoaded('items')).toBe(true)
    expect(queries.filter((sql) => sql.startsWith('select'))).toHaveLength(1)
  })

  test('loadMissing skips what is already there', async () => {
    const shops = await Shop.query().with('items').get()

    capturing = true

    await shops.loadMissing('items')

    expect(queries).toHaveLength(0)
  })

  test('and an empty collection is not a query', async () => {
    const none = new ModelCollection<Shop>([])

    await none.load('items')

    expect(none.count()).toBe(0)
  })
})

describe('keys', () => {
  test('modelKeys is what the next whereIn wants', async () => {
    const shops = await Shop.query().orderBy('id').get()

    expect(shops.modelKeys()).toEqual([1, 2])
  })

  test('toQuery reaches exactly these models', async () => {
    const shops = await Shop.query().where('name', 'One').get()

    expect(await shops.toQuery().count()).toBe(1)
  })

  test('and an empty one refuses rather than matching everything', async () => {
    expect(() => new ModelCollection<Shop>([]).toQuery()).toThrow('empty collection')
  })
})

/** Two reads of the same row are two objects, so identity was always wrong. */
describe('comparing by key', () => {
  test('onlyKeys, exceptKeys and diffKeys', async () => {
    const shops = await Shop.query().orderBy('id').get()
    const first = shops.first() as Shop

    expect(shops.onlyKeys([1]).count()).toBe(1)
    expect(shops.exceptKeys([1]).modelKeys()).toEqual([2])
    expect(shops.diffKeys([first]).modelKeys()).toEqual([2])
  })

  test('and a re-read of the same row is not a difference', async () => {
    const shops = await Shop.query().orderBy('id').get()
    const again = await Shop.query().orderBy('id').get()

    expect(shops.diffKeys(again).count()).toBe(0)
  })
})

describe('fresh', () => {
  test('re-reads them all in one query, keeping the order', async () => {
    const shops = await Shop.query().orderByDesc('id').get()

    await Shop.query().where('id', 1).update({ name: 'Renamed' })

    const reread = await shops.fresh()

    expect(reread.modelKeys()).toEqual([2, 1])
    expect(reread.last()?.name).toBe('Renamed')
  })
})

describe('serialisation', () => {
  test('makeVisible reaches a hidden column', async () => {
    const shops = await Shop.query().get()

    const before = shops.first()?.toObject() as { secret?: string } | undefined

    expect(before?.secret).toBeUndefined()

    shops.makeVisible('secret')

    expect((shops.first()?.toObject() as { secret?: string } | undefined)?.secret).toBe('a')
  })

  test('append adds an accessor for these models only', async () => {
    const shops = await Shop.query().get()

    shops.append('shouty')

    expect((shops.first()?.toObject() as { shouty?: string } | undefined)?.shouty).toBe('ONE')

    const others = await Shop.query().get()

    expect((others.first()?.toObject() as { shouty?: string } | undefined)?.shouty).toBeUndefined()
  })
})

/** Everything the plain collection did still works. */
describe('it is still a Collection', () => {
  test('map and filter behave as they always did', async () => {
    const shops = await Shop.query().orderBy('id').get()

    expect(shops).toBeInstanceOf(Collection)
    expect(shops.map((shop) => shop.name).all()).toEqual(['One', 'Two'])
    expect(shops.filter((shop) => shop.name === 'Two').count()).toBe(1)
  })
})
