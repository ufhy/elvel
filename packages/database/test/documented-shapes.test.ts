import { beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { Factory } from '../src/factory.ts'
import { Model } from '../src/model/model.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

class Author extends Model {
  static override table = 'authors'
  static override timestamps = false
  static override fillable = ['name']
  declare name: string
  books() {
    return this.hasMany(Book, 'author_id')
  }
}
class Book extends Model {
  static override table = 'books'
  static override timestamps = false
  static override fillable = ['title', 'author_id']
  declare title: string
}
class AuthorFactory extends Factory<Author> {
  readonly model = Author
  definition(i: number) {
    return { name: `Author ${i}` }
  }
}
class BookFactory extends Factory<Book> {
  readonly model = Book
  definition(i: number) {
    return { title: `Book ${i}` }
  }
}

let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('t', { driver: 'sqlite', database: ':memory:' })
  Model.setConnectionResolver(async () => connection)
  Model.setEventDispatcher(undefined)
  const schema = new SchemaBuilder(connection)
  await schema.create('authors', (t) => {
    t.id()
    t.string('name')
  })
  await schema.create('slugs', (t) => {
    t.id()
    t.string('name').unique()
    t.integer('views').default(0)
  })
  await schema.create('books', (t) => {
    t.id()
    t.integer('author_id').nullable()
    t.string('title')
  })
})

/**
 * The snippets in the documentation, run as written.
 *
 * Three commits shipped `firstOrNew`, `ModelCollection` and the factory graph
 * with no documentation at all — the behaviour was locked by tests and only the
 * way to find it was missing. Writing that documentation is what these guard:
 * a page that shows a call shape nobody runs drifts the moment a signature does,
 * and the reader is the one who finds out.
 *
 * Two of them were written wrong here first, and the database said so: `upsert`
 * needs a unique index behind the columns it matches on, which is now a caveat
 * on the page rather than an error somebody else meets.
 */
describe('what the documentation shows', () => {
  test('finding and writing', async () => {
    const made = await Author.query().firstOrNew({ name: 'Ada' })
    expect(made.exists).toBe(false)

    const created = await Author.query().firstOrCreate({ name: 'Grace' })
    expect(created.exists).toBe(true)

    // Its own table: the columns matched on need a unique index, which is the
    // caveat the docs now carry.
    class Slug extends Model {
      static override table = 'slugs'
      static override timestamps = false
      static override fillable = ['name', 'views']

      declare views: number
    }

    await Slug.upsert(
      [
        { name: 'a', views: 1 },
        { name: 'b', views: 1 }
      ],
      ['name'],
      ['views']
    )
    await Slug.upsert([{ name: 'a', views: 9 }], ['name'], ['views'])

    expect(await Slug.query().count()).toBe(2)
    expect((await Slug.query().where('name', 'a').first())?.views).toBe(9)
  })

  test('the collection shapes', async () => {
    await new AuthorFactory().count(2).has(new BookFactory().count(3), 'author_id').create()

    const authors = await Author.query().get()

    await authors.load('books')
    await authors.loadMissing('books')
    await authors.loadCount('books')

    expect(authors.modelKeys()).toHaveLength(2)
    expect((await authors.fresh()).count()).toBe(2)
    expect(await authors.toQuery().count()).toBe(2)
  })

  test('the factory graph', async () => {
    await new BookFactory().count(15).for(new AuthorFactory(), 'author_id').create()
    expect(await Author.query().count()).toBe(1)

    const rows = await new AuthorFactory()
      .count(4)
      .sequence({ name: 'free' }, { name: 'paid' })
      .raw()
    expect(rows.map((r) => r.name)).toEqual(['free', 'paid', 'free', 'paid'])

    const cross = await new AuthorFactory()
      .count(4)
      .crossJoinSequence([{ name: 'a' }, { name: 'b' }], [{ nickname: 'x' }, { nickname: 'y' }])
      .raw()
    expect(cross).toHaveLength(4)

    const one = await new AuthorFactory().makeOne({ name: 'Ada' })
    expect(one.exists).toBe(false)

    expect((await new AuthorFactory().createMany([{ name: 'A' }, { name: 'B' }])).count()).toBe(2)
    expect((await new AuthorFactory().createQuietly()).count()).toBe(1)
  })
})
