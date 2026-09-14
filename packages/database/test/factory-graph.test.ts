import { beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { Factory } from '../src/factory.ts'
import { Model } from '../src/model/model.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

class Author extends Model {
  static override table = 'authors'
  static override timestamps = false

  declare name: string
}

class Genre extends Model {
  static override table = 'genres'
  static override timestamps = false

  declare name: string
}

class Book extends Model {
  static override table = 'books'
  static override timestamps = false

  declare title: string
  declare author_id: number

  genres() {
    return this.belongsToMany(Genre)
  }
}

class GenreFactory extends Factory<Genre> {
  readonly model = Genre

  definition(index: number) {
    return { name: `Genre ${index}` }
  }
}

class AuthorFactory extends Factory<Author> {
  readonly model = Author

  definition(index: number) {
    return { name: `Author ${index}` }
  }
}

class BookFactory extends Factory<Book> {
  readonly model = Book

  definition(index: number) {
    return { title: `Book ${index}` }
  }
}

let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  Model.setConnectionResolver(async () => connection)
  Model.setEventDispatcher(undefined)

  const schema = new SchemaBuilder(connection)

  await schema.create('authors', (table) => {
    table.id()
    table.string('name')
  })
  await schema.create('books', (table) => {
    table.id()
    table.integer('author_id').nullable()
    table.string('title')
  })
  await schema.create('genres', (table) => {
    table.id()
    table.string('name')
  })
  // `Book` + `Genre` sort to `book_genre`, which is the convention the relation
  // resolves to.
  await schema.create('book_genre', (table) => {
    table.integer('book_id')
    table.integer('genre_id')
  })
})

/** Seeding anything with relations meant writing the loops. */
describe('has', () => {
  test('creates children for each model', async () => {
    await new AuthorFactory().count(2).has(new BookFactory().count(3)).create()

    expect(await Author.query().count()).toBe(2)
    expect(await Book.query().count()).toBe(6)
  })

  test('and keys them to their parent', async () => {
    const authors = await new AuthorFactory().has(new BookFactory().count(2)).create()
    const author = authors.first() as Author

    expect(await Book.query().where('author_id', author.getKey()).count()).toBe(2)
  })

  test('a named foreign key wins over the convention', async () => {
    await new AuthorFactory().has(new BookFactory().count(1), 'author_id').create()

    expect(await Book.query().whereNotNull('author_id').count()).toBe(1)
  })
})

describe('for', () => {
  test('creates the parent first and carries its key', async () => {
    const books = await new BookFactory().count(2).for(new AuthorFactory()).create()

    expect(await Author.query().count()).toBe(1)
    expect((books.first() as Book).author_id).toBe(
      (await Author.query().first())?.getKey() as number
    )
  })

  /** Fifteen users for fifteen comments was never what the fixture meant. */
  test('and one parent is shared across the batch', async () => {
    await new BookFactory().count(5).for(new AuthorFactory()).create()

    expect(await Author.query().count()).toBe(1)
  })

  test('recycle shares one the caller already has', async () => {
    const author = await new AuthorFactory().createOne()

    await new BookFactory().count(2).recycle(author).for(new AuthorFactory()).create()

    expect(await Author.query().count()).toBe(1)
    expect(await Book.query().where('author_id', author.getKey()).count()).toBe(2)
  })
})

describe('hasAttached', () => {
  test('creates the others and attaches them through the pivot', async () => {
    const books = await new BookFactory()
      .hasAttached(new GenreFactory().count(2), 'genres')
      .create()

    const book = books.first() as Book

    expect(await Genre.query().count()).toBe(2)
    expect((await book.genres().get()).count()).toBe(2)
  })
})

describe('sequences', () => {
  test('cycle across the batch', async () => {
    const rows = await new AuthorFactory()
      .count(4)
      .sequence({ name: 'Ada' }, { name: 'Grace' })
      .raw()

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace', 'Ada', 'Grace'])
  })

  test('crossJoinSequence is every combination', async () => {
    const rows = await new AuthorFactory()
      .count(4)
      .crossJoinSequence([{ name: 'a' }, { name: 'b' }], [{ nickname: 'x' }, { nickname: 'y' }])
      .raw()

    expect(rows.map((row) => `${row.name}${row.nickname}`)).toEqual(['ax', 'ay', 'bx', 'by'])
  })

  test('and an empty sequence changes nothing', async () => {
    const rows = await new AuthorFactory().count(1).sequence().raw()

    expect(rows[0]?.name).toBe('Author 0')
  })
})

describe('hooks', () => {
  test('afterMaking sees the unsaved model, afterCreating the saved one', async () => {
    const seen: Array<[string, boolean]> = []

    await new AuthorFactory()
      .count(2)
      .afterMaking((model) => seen.push(['making', model.exists]))
      .afterCreating((model) => seen.push(['creating', model.exists]))
      .create()

    expect(seen).toEqual([
      ['making', false],
      ['making', false],
      ['creating', true],
      ['creating', true]
    ])
  })
})

describe('the rest', () => {
  test('makeOne and createMany', async () => {
    const made = await new AuthorFactory().makeOne({ name: 'Ada' })

    expect(made.exists).toBe(false)
    expect(made.name).toBe('Ada')

    const many = await new AuthorFactory().createMany([{ name: 'One' }, { name: 'Two' }])

    expect(many.count()).toBe(2)
    expect(await Author.query().count()).toBe(2)
  })
})

/** A model importing its own factory would put fixtures in the bundle. */
describe('Model.factory', () => {
  test('resolves what was registered', async () => {
    Model.registerFactory(Author, () => new AuthorFactory())

    const factory = Author.factory(2) as AuthorFactory

    expect((await factory.create()).count()).toBe(2)
  })

  test('and names the model when nothing is registered', () => {
    expect(() => Book.factory()).toThrow('No factory registered for Book')
  })
})
