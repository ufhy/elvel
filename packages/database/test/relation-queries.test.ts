import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

/**
 * The `QueriesRelationships` family, ported from Laravel 13's own assertions.
 *
 * `tests/Database/DatabaseEloquentBuilderTest.php` checks these by comparing
 * generated SQL — `$this->assertSame('select … exists(select * from …)', $builder->toSql())`
 * — which is the one form that transfers exactly: the expectation comes from
 * their file rather than from a belief about what the SQL ought to be.
 *
 * What could not be copied verbatim is the *table and column names*, which are
 * their fixtures'. The structure is asserted here against ours, and where the two
 * differ in more than names the test says so.
 *
 * Twelve of these methods did not exist before this file. `orWhereHas` was the
 * plainest gap: `whereHas` was there, its `or` twin was not, and "posts or
 * comments" has no workaround short of writing the `exists` subquery by hand —
 * which means repeating the foreign key the relation already knows.
 */
class Author extends Model {
  static override table = 'authors'
  static override timestamps = false

  declare id: number
  declare name: string

  posts() {
    return this.hasMany(Post, 'author_id', 'id')
  }
}

class Post extends Model {
  static override table = 'posts'
  static override timestamps = false

  declare id: number
  declare author_id: number
  declare title: string
  declare published: number

  author() {
    return this.belongsTo(Author, 'author_id', 'id')
  }

  comments() {
    return this.hasMany(Comment, 'post_id', 'id')
  }
}

class Comment extends Model {
  static override table = 'comments'
  static override timestamps = false

  declare id: number
  declare post_id: number
  declare body: string
  declare approved: number
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

  await connection.statement('create table authors (id integer primary key, name text)')
  await connection.statement(
    'create table posts (id integer primary key, author_id integer, title text, published integer)'
  )
  await connection.statement(
    'create table comments (id integer primary key, post_id integer, body text, approved integer)'
  )

  await connection.statement("insert into authors values (1,'Ada'),(2,'Grace'),(3,'Nobody')")
  await connection.statement(
    "insert into posts values (1,1,'First',1),(2,1,'Draft',0),(3,2,'Only',1)"
  )
  await connection.statement("insert into comments values (1,1,'Nice',1),(2,2,'Hidden',0)")
})

describe('the or half of the has family — testOrHas, testOrWhereHas', () => {
  test('orWhereHas joins with or rather than and', async () => {
    const sql = await Author.query().where('name', 'Nobody').orWhereHas('posts').toSql()

    // The `or` is the whole point: with `and` this answers nothing, because the
    // author called Nobody is exactly the one with no posts.
    expect<boolean>(sql.includes(' or exists')).toBe(true)

    const found = await Author.query().where('name', 'Nobody').orWhereHas('posts').get()

    expect<number>(found.length).toBe(3)
  })

  test('and whereHas still joins with and', async () => {
    const found = await Author.query().where('name', 'Nobody').whereHas('posts').get()

    expect<number>(found.length).toBe(0)
  })

  test('orWhereHas takes a constraint, like its and twin', async () => {
    const found = await Author.query()
      .where('name', 'Grace')
      .orWhereHas('posts', (query) => {
        query.where('published', 0)
      })
      .get()

    // Grace by name, Ada by her unpublished draft.
    expect<string[]>(
      found
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Ada', 'Grace'])
  })

  test('orDoesntHave and orWhereDoesntHave negate it', async () => {
    const sql = await Author.query().where('name', 'Ada').orDoesntHave('posts').toSql()

    expect<boolean>(sql.includes(' or not exists')).toBe(true)

    const found = await Author.query().where('name', 'Ada').orDoesntHave('posts').get()

    expect<string[]>(
      found
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Ada', 'Nobody'])
  })
})

describe('whereRelation — testWhereRelation', () => {
  /**
   * The same as `whereHas` with a one-line callback, and worth having for the
   * reason Laravel added it: a filter on a relation is the commonest thing anybody
   * writes, and the callback form buries the condition inside a closure.
   */
  test('the two-argument form means equals', async () => {
    const found = await Author.query().whereRelation('posts', 'published', 0).get()

    expect<string[]>(found.map((author) => author.name).all()).toEqual(['Ada'])
  })

  test('and the three-argument form takes an operator', async () => {
    const found = await Author.query().whereRelation('posts', 'id', '>', 2).get()

    expect<string[]>(found.map((author) => author.name).all()).toEqual(['Grace'])
  })

  test('orWhereRelation joins with or', async () => {
    const found = await Author.query()
      .where('name', 'Nobody')
      .orWhereRelation('posts', 'published', 1)
      .get()

    expect<string[]>(
      found
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Ada', 'Grace', 'Nobody'])
  })

  test('whereDoesntHaveRelation is the negation', async () => {
    const found = await Author.query().whereDoesntHaveRelation('posts', 'published', 1).get()

    // Nobody has no posts at all, so no published one either.
    expect<string[]>(found.map((author) => author.name).all()).toEqual(['Nobody'])
  })
})

describe('withExists — testWithExists', () => {
  /**
   * The SQL shape is Laravel's, from `testWithExists`:
   *
   * ```
   * select "t".*, exists(select * from "related" where … ) as "foo_exists" from "t"
   * ```
   *
   * `exists(...)` wraps the subquery rather than being a function inside one, and
   * that is not only syntax: it lets the database stop at the first matching row,
   * which is the whole reason to reach for this over `withCount`.
   */
  test('adds an exists column that wraps the subquery', async () => {
    const sql = await Author.query().withExists('posts').toSql()

    expect<boolean>(sql.includes('exists(select * from')).toBe(true)
    expect<boolean>(sql.includes('posts_exists')).toBe(true)
    expect<boolean>(sql.includes('select exists(')).toBe(false)
  })

  test('and answers a truthy value per row', async () => {
    const authors = await Author.query().withExists('posts').get()
    const seen = Object.fromEntries(
      authors
        .map((author) => [
          author.name,
          Boolean((author as unknown as Record<string, unknown>).posts_exists)
        ])
        .all()
    )

    expect<unknown>(seen).toEqual({ Ada: true, Grace: true, Nobody: false })
  })

  test('the model’s own columns survive it', async () => {
    const authors = await Author.query().withExists('posts').get()

    expect<string[]>(
      authors
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Ada', 'Grace', 'Nobody'])
  })
})

describe('whereBelongsTo — testWhereBelongsTo', () => {
  /**
   * Laravel's assertion is on the *call*, not the SQL: it expects
   * `whereIn('<table>.<foreignKey>', [<parent keys>], 'and')`. So this asserts the
   * same thing — an `in` against the child's foreign key, not an `exists`
   * subquery, which is what a reader would otherwise assume from the name.
   */
  test('constrains the child’s foreign key to the parent’s key', async () => {
    const ada = (await Author.query().where('name', 'Ada').first()) as Author
    const sql = await Post.query().whereBelongsTo(ada).toSql()

    expect<boolean>(sql.includes('exists')).toBe(false)
    expect<boolean>(sql.includes('in (')).toBe(true)

    const posts = await Post.query().whereBelongsTo(ada).get()

    expect<string[]>(
      posts
        .map((post) => post.title)
        .all()
        .sort()
    ).toEqual(['Draft', 'First'])
  })

  test('takes a list of parents', async () => {
    const authors = await Author.query().get()
    const posts = await Post.query().whereBelongsTo(authors).get()

    expect<number>(posts.length).toBe(3)
  })

  test('and the relation may be named, for a table with two keys to one model', async () => {
    const ada = (await Author.query().where('name', 'Ada').first()) as Author
    const posts = await Post.query().whereBelongsTo(ada, 'author').get()

    expect<string[]>(
      posts
        .map((post) => post.title)
        .all()
        .sort()
    ).toEqual(['Draft', 'First'])
  })

  test('orWhereBelongsTo joins with or', async () => {
    const grace = (await Author.query().where('name', 'Grace').first()) as Author
    const posts = await Post.query().where('published', 0).orWhereBelongsTo(grace).get()

    expect<string[]>(
      posts
        .map((post) => post.title)
        .all()
        .sort()
    ).toEqual(['Draft', 'Only'])
  })

  /**
   * A relation that is not a `belongsTo` is refused, by name.
   *
   * The alternative is a query with no constraint on it, which answers every row
   * and looks like it worked.
   */
  test('refuses a relation that does not hold the key', async () => {
    const ada = (await Author.query().where('name', 'Ada').first()) as Author

    expect(() => Author.query().whereBelongsTo(ada, 'posts')).toThrow('is not a belongsTo')
  })

  test('and refuses an empty list rather than matching everything', () => {
    expect(() => Post.query().whereBelongsTo([])).toThrow('at least one model')
  })
})

describe('nested relations', () => {
  test('whereHas reaches a relation of a relation through its callback', async () => {
    const authors = await Author.query()
      .whereHas('posts', (query) => {
        query.whereHas('comments', (comments) => {
          comments.where('approved', 1)
        })
      })
      .get()

    expect<string[]>(authors.map((author) => author.name).all()).toEqual(['Ada'])
  })
})
