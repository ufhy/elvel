import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { Model } from '../src/model/model.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

class Writer extends Model {
  static override table = 'writers'
  static override timestamps = false
  static override fillable = ['name']

  declare name: string

  articles() {
    return this.hasMany(Article, 'writer_id')
  }
}

class Article extends Model {
  static override table = 'articles'
  static override timestamps = false
  static override fillable = ['writer_id', 'title']

  declare title: string
}

let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  Model.setConnectionResolver(async () => connection)
  Model.setEventDispatcher(undefined)

  const schema = new SchemaBuilder(connection)

  await schema.create('writers', (table) => {
    table.id()
    table.string('name')
  })
  await schema.create('articles', (table) => {
    table.id()
    table.integer('writer_id')
    table.string('title')
  })

  await Writer.create({ name: 'Ada' })
  await Writer.create({ name: 'Grace' })
})

afterEach(() => {
  Model.shouldBeStrict(false)
  Model.takeHydratedCount()
})

/** A rename that missed `fillable` silently stops saving that column. */
describe('preventSilentlyDiscardingAttributes', () => {
  test('a key that is not fillable is dropped by default', () => {
    const writer = new Writer({ name: 'Ada', admin: true })

    expect(writer.name).toBe('Ada')
  })

  test('and refused when strict', () => {
    Model.preventSilentlyDiscardingAttributes()

    expect(() => new Writer({ name: 'Ada', admin: true })).toThrow('[admin] is not fillable')
  })

  test('forceFill still assigns, which is what it is for', () => {
    Model.preventSilentlyDiscardingAttributes()

    const writer = new Writer()
    writer.forceFill({ admin: true })

    expect((writer as unknown as { admin: boolean }).admin).toBe(true)
  })
})

/** `user.emial` is undefined, and it fails somewhere else entirely. */
describe('preventAccessingMissingAttributes', () => {
  test('a missing key reads as undefined by default', async () => {
    const writer = (await Writer.query().first()) as Writer

    expect((writer as unknown as { nope: unknown }).nope).toBeUndefined()
  })

  test('and throws when strict', async () => {
    const writer = (await Writer.query().first()) as Writer

    Model.preventAccessingMissingAttributes()

    expect(() => (writer as unknown as { nope: unknown }).nope).toThrow('is not an attribute')
  })

  /** A new model is being filled, and half its attributes are legitimately absent. */
  test('but a model that does not exist yet is left alone', () => {
    Model.preventAccessingMissingAttributes()

    const writer = new Writer({ name: 'Ada' })

    expect((writer as unknown as { nope: unknown }).nope).toBeUndefined()
  })
})

/**
 * Not upstream's guard, because a relation here is a method and nothing queries
 * by accident. What is still real is the N+1 it was written to catch.
 */
describe('preventLazyLoading', () => {
  test('a relation asked for per model of a set is refused', async () => {
    const writers = await Writer.query().get()

    Model.preventLazyLoading()

    expect(() => (writers.first() as Writer).articles()).toThrow('was queried for one Writer')
  })

  /**
   * Eager loading is the fix, and the loaded relation is read back rather than
   * queried again — calling the method a second time *is* a second query, which
   * is what the guard is for.
   */
  test('and eager loading is unaffected by the guard', async () => {
    Model.preventLazyLoading()

    const writers = await Writer.query().with('articles').get()

    expect(writers.first()?.relationLoaded('articles')).toBe(true)
    expect(writers.first()?.getRelation('articles')).toBeDefined()
  })

  test('but calling the method again is still a second query, and refused', async () => {
    const writers = await Writer.query().with('articles').get()

    Model.preventLazyLoading()

    expect(() => (writers.first() as Writer).articles()).toThrow('that is an N+1')
  })

  /** One model is not an N+1, whatever it does next. */
  test('a single model is never refused', async () => {
    const writer = (await Writer.query().first()) as Writer

    Model.preventLazyLoading()

    expect(() => writer.articles()).not.toThrow()
  })
})

/** The number that exposes a query pulling a whole table. */
describe('the hydration counter', () => {
  test('counts what was built', async () => {
    Model.takeHydratedCount()

    await Writer.query().get()

    expect(Model.hydratedCount()).toBe(2)
  })

  test('and taking it zeroes it, which is what a per-request recorder wants', async () => {
    await Writer.query().get()

    expect(Model.takeHydratedCount()).toBeGreaterThan(0)
    expect(Model.hydratedCount()).toBe(0)
  })
})

describe('shouldBeStrict', () => {
  test('turns on all three, and off again', () => {
    Model.shouldBeStrict()

    expect(() => new Writer({ admin: true })).toThrow('not fillable')

    Model.shouldBeStrict(false)

    expect(() => new Writer({ admin: true })).not.toThrow()
  })
})
