import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { EventServiceProvider } from '@elvel/events'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

/**
 * Constrained eager loading, and the six methods that needed it.
 *
 * `with('posts')` existed; `with({ posts: (query) => … })` did not — which a
 * name-level comparison against Laravel could not see, because the *name* `with`
 * was there. Without it the only way to eager-load part of a relation is to load
 * all of it and filter in memory, which is the exact cost the eager load exists to
 * avoid.
 *
 * `withWhereHas` is built on it: `whereHas` narrows the parents and `with` loads
 * the children, and a constraint written into one and not the other gives a page
 * listing authors who have published something — alongside all of their drafts.
 */
class Author extends Model {
  static override table = 'authors'
  static override timestamps = false

  declare id: number
  declare name: string

  posts() {
    return this.hasMany(Post, 'author_id', 'id')
  }

  tags() {
    return this.belongsToMany(Tag, 'author_tag', 'author_id', 'tag_id')
  }
}

class Post extends Model {
  static override table = 'posts'
  static override timestamps = false

  declare id: number
  declare author_id: number
  declare title: string
  declare published: number
}

class Tag extends Model {
  static override table = 'tags'
  static override timestamps = false

  declare id: number
  declare name: string
}

/** Every statement the connection ran, so "filtered where?" can be answered. */
let statements: string[] = []

beforeEach(async () => {
  const app = new Application(process.cwd())

  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  /**
   * The event dispatcher, because `DB.listen` needs one.
   *
   * Registered here rather than assumed: the assertion that matters in this file
   * is *where* the filtering happened, and that can only be read off the SQL the
   * connection actually ran.
   */
  await app.register(EventServiceProvider)
  await app.register(DatabaseServiceProvider)
  await app.boot()

  const connection = await app.make('db').connection()

  await connection.statement('create table authors (id integer primary key, name text)')
  await connection.statement(
    'create table posts (id integer primary key, author_id integer, title text, published integer)'
  )
  await connection.statement('create table tags (id integer primary key, name text)')
  await connection.statement('create table author_tag (author_id integer, tag_id integer)')

  await connection.statement("insert into authors values (1,'Ada'),(2,'Grace'),(3,'Nobody')")
  await connection.statement(
    "insert into posts values (1,1,'Published',1),(2,1,'Draft',0),(3,2,'Only',1)"
  )
  await connection.statement("insert into tags values (1,'sql'),(2,'prose')")
  await connection.statement('insert into author_tag values (1,1),(2,2)')

  statements = []
  app.make('db').listen((query) => statements.push(query.sql))
})

describe('with({ relation: constraint })', () => {
  test('the constraint reaches the child query, not a filter afterwards', async () => {
    const authors = await Author.query()
      .with({ posts: (query) => query.where('published', 1) })
      .get()

    const ada = authors.first() as Author
    const loaded = ada.getRelation('posts') as { all: () => Post[] }

    expect<string[]>(loaded.all().map((post) => post.title)).toEqual(['Published'])

    /**
     * The proof that it filtered in the database.
     *
     * A constraint applied in memory would still answer the right titles here, so
     * the assertion that matters is on the SQL: the eager query itself has to
     * carry the condition.
     */
    const eager = statements.find((sql) => sql.includes('from "posts"')) as string

    expect<boolean>(eager.includes('"published"')).toBe(true)
  })

  test('the plain form still works, and the two can be mixed', async () => {
    const authors = await Author.query()
      .with('tags')
      .with({ posts: (query) => query.where('published', 0) })
      .get()

    const ada = authors.first() as Author

    expect<number>((ada.getRelation('posts') as { all: () => Post[] }).all().length).toBe(1)
    expect<number>((ada.getRelation('tags') as { all: () => Tag[] }).all().length).toBe(1)
  })

  test('an order inside the constraint reaches the query too', async () => {
    await Author.query()
      .with({ posts: (query) => query.orderByDesc('id') })
      .get()

    const eager = statements.find((sql) => sql.includes('from "posts"')) as string

    expect<boolean>(eager.includes('order by')).toBe(true)
  })

  test('a many-to-many takes one as well, on top of its pivot constraints', async () => {
    const authors = await Author.query()
      .with({ tags: (query) => query.where('name', 'sql') })
      .get()

    const ada = authors.first() as Author
    const grace = authors.all()[1] as Author

    expect<string[]>(
      (ada.getRelation('tags') as { all: () => Tag[] }).all().map((t) => t.name)
    ).toEqual(['sql'])
    // Grace's tag is `prose`, so hers is filtered out — per parent, in one query.
    expect<number>((grace.getRelation('tags') as { all: () => Tag[] }).all().length).toBe(0)
  })
})

describe('withWhereHas', () => {
  test('filters the parents and loads the children with the same constraint', async () => {
    const authors = await Author.query()
      .withWhereHas('posts', (query) => query.where('published', 1))
      .get()

    // Nobody has no posts, so no published ones: filtered out as a parent.
    expect<string[]>(
      authors
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Ada', 'Grace'])

    const ada = authors.first() as Author

    // And the drafts are not loaded, which is the half that is easy to forget.
    expect<string[]>(
      (ada.getRelation('posts') as { all: () => Post[] }).all().map((post) => post.title)
    ).toEqual(['Published'])
  })

  test('without a callback it is whereHas plus with', async () => {
    const authors = await Author.query().withWhereHas('posts').get()

    expect<string[]>(
      authors
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Ada', 'Grace'])

    const ada = authors.first() as Author

    expect<number>((ada.getRelation('posts') as { all: () => Post[] }).all().length).toBe(2)
  })

  test('withWhereRelation is the sugar form of the same thing', async () => {
    const authors = await Author.query().withWhereRelation('posts', 'published', 1).get()

    expect<string[]>(
      authors
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Ada', 'Grace'])

    const ada = authors.first() as Author

    expect<string[]>(
      (ada.getRelation('posts') as { all: () => Post[] }).all().map((post) => post.title)
    ).toEqual(['Published'])
  })
})

describe('whereAttachedTo', () => {
  test('finds the rows joined through a pivot', async () => {
    const sql = (await Tag.query().where('name', 'sql').first()) as Tag
    const authors = await Author.query().whereAttachedTo(sql).get()

    expect<string[]>(authors.map((author) => author.name).all()).toEqual(['Ada'])
  })

  test('takes several, and the relation may be named', async () => {
    const tags = await Tag.query().get()
    const authors = await Author.query().whereAttachedTo(tags, 'tags').get()

    expect<string[]>(
      authors
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Ada', 'Grace'])
  })

  test('orWhereAttachedTo joins with or', async () => {
    const prose = (await Tag.query().where('name', 'prose').first()) as Tag
    const authors = await Author.query().where('name', 'Nobody').orWhereAttachedTo(prose).get()

    expect<string[]>(
      authors
        .map((author) => author.name)
        .all()
        .sort()
    ).toEqual(['Grace', 'Nobody'])
  })

  /**
   * The relation is guessed as the **plural**, where `whereBelongsTo` guesses the
   * singular: the child holds one key, a pivot holds many.
   */
  test('a relation that is not a many-to-many is refused by name', async () => {
    const sql = (await Tag.query().find(1)) as Tag

    expect(() => Author.query().whereAttachedTo(sql, 'posts')).toThrow('is not a belongsToMany')
  })

  test('and an empty list is refused rather than matching everything', () => {
    expect(() => Author.query().whereAttachedTo([])).toThrow('empty list')
  })
})

describe('withAggregate', () => {
  test('is the general form the with* aggregates are built on', async () => {
    const authors = await Author.query().withAggregate('posts', 'id', 'count').get()
    const ada = authors.first() as unknown as Record<string, unknown>

    expect<number>(Number(ada.posts_count_id)).toBe(2)
  })

  test('and reaches a function this framework has no shorthand for', async () => {
    const authors = await Author.query().withAggregate('posts', 'title', 'group_concat').get()
    const ada = authors.first() as unknown as Record<string, unknown>

    expect<boolean>(String(ada.posts_group_concat_title).includes('Published')).toBe(true)
  })
})

describe('mergeConstraintsFrom', () => {
  test('copies another builder’s constraints onto this one', async () => {
    const published = Post.query().where('published', 1)
    const found = await Post.query().where('author_id', 1).mergeConstraintsFrom(published).get()

    expect<string[]>(found.map((post) => post.title).all()).toEqual(['Published'])
  })
})
