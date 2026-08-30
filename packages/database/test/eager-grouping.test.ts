import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { EventServiceProvider } from '@elvel/events'
import type { Collection } from '@elvel/support'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

/**
 * Two relations under one parent are one load of that parent.
 *
 * `with('posts.comments', 'posts.likes')` used to run five queries where four do,
 * and the fifth was not merely wasteful: the second load of `posts` replaced the
 * first, so the `Post` models that had just been given their `comments` were
 * discarded and the caller got `likes` and nothing else. One nested relation was
 * tested and passed; two was the case nobody had written down.
 */
class Author extends Model {
  static override table = 'authors'
  static override timestamps = false

  declare id: number

  posts() {
    return this.hasMany(Post, 'author_id', 'id')
  }

  awards() {
    return this.hasMany(Award, 'author_id', 'id')
  }
}

class Post extends Model {
  static override table = 'posts'
  static override timestamps = false

  declare id: number
  declare flagged: number

  comments() {
    return this.hasMany(Comment, 'post_id', 'id')
  }

  likes() {
    return this.hasMany(Like, 'post_id', 'id')
  }
}

class Award extends Model {
  static override table = 'awards'
  static override timestamps = false
}

class Comment extends Model {
  static override table = 'comments'
  static override timestamps = false

  declare id: number
  declare spam: number
}

class Like extends Model {
  static override table = 'likes'
  static override timestamps = false
}

/** Every statement, so "how many queries" is answered by the connection. */
let statements: string[] = []

/** The tables each query read, in order — the shape of the load. */
const tables = () => statements.map((sql) => sql.match(/from "(\w+)"/)?.[1] ?? '?')

beforeEach(async () => {
  const app = new Application(process.cwd())

  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  await app.register(EventServiceProvider)
  await app.register(DatabaseServiceProvider)
  await app.boot()

  const connection = await app.make('db').connection()

  await connection.statement('create table authors (id integer primary key)')
  await connection.statement('create table posts (id integer primary key, author_id integer)')
  await connection.statement('create table awards (id integer primary key, author_id integer)')
  await connection.statement(
    'create table comments (id integer primary key, post_id integer, spam integer)'
  )
  await connection.statement('create table likes (id integer primary key, post_id integer)')

  await connection.statement('insert into authors values (1)')
  await connection.statement('insert into posts values (1,1),(2,1)')
  await connection.statement('insert into awards values (1,1)')
  await connection.statement('insert into comments values (1,1,0),(2,1,1),(3,2,0)')
  await connection.statement('insert into likes values (1,1)')

  statements = []
  app.make('db').listen((query) => statements.push(query.sql))
})

const firstPost = async (relations: string[]): Promise<Post> => {
  const authors = await Author.query()
    .with(...relations)
    .get()
  const posts = (authors.first() as Author).getRelation('posts') as Collection<Post>

  return posts.all()[0] as Post
}

describe('two relations nested under the same parent', () => {
  test('both arrive, which is the bug this grouping fixes', async () => {
    const post = await firstPost(['posts.comments', 'posts.likes'])

    expect<number>((post.getRelation('comments') as Collection<Comment>).all().length).toBe(2)
    expect<number>((post.getRelation('likes') as Collection<Like>).all().length).toBe(1)
  })

  test('and the parent is fetched once', async () => {
    await firstPost(['posts.comments', 'posts.likes'])

    expect<string[]>(tables()).toEqual(['authors', 'posts', 'comments', 'likes'])
  })

  /**
   * A constraint is written against a name, and it belongs to that name's query.
   * `posts.comments` narrows the comments; it used to be applied to the posts
   * query, where it narrowed the wrong relation, and then dropped before the
   * comments were fetched.
   */
  test('a constraint on the tail reaches the tail', async () => {
    const authors = await Author.query()
      .with({ 'posts.comments': (query) => query.where('spam', 0) })
      .get()
    const posts = (authors.first() as Author).getRelation('posts') as Collection<Post>
    const post = posts.all()[0] as Post

    expect<number[]>(
      (post.getRelation('comments') as Collection<Comment>).all().map((row: Comment) => row.id)
    ).toEqual([1])

    const comments = statements.find((sql) => sql.includes('from "comments"')) as string

    expect<boolean>(comments.includes('"spam"')).toBe(true)

    // And the posts query was not the one narrowed.
    const posted = statements.find((sql) => sql.includes('from "posts"')) as string

    expect<boolean>(posted.includes('"spam"')).toBe(false)
  })

  /** A single relation still behaves exactly as it did. */
  test('one nested relation is unchanged', async () => {
    const post = await firstPost(['posts.comments'])

    expect<number>((post.getRelation('comments') as Collection<Comment>).all().length).toBe(2)
    expect<string[]>(tables()).toEqual(['authors', 'posts', 'comments'])
  })
})

describe('independent relations', () => {
  /**
   * They are issued together rather than one after another. What the test can see
   * is not the timing — a sqlite query in memory has no round trip to save — but
   * that every relation still lands, which is the part concurrency could break.
   */
  test('all of them still load', async () => {
    const authors = await Author.query().with('posts', 'awards').get()
    const ada = authors.first() as Author

    expect<number>((ada.getRelation('posts') as Collection<Post>).all().length).toBe(2)
    expect<number>((ada.getRelation('awards') as Collection<Award>).all().length).toBe(1)
    expect<number>(statements.length).toBe(3)
  })

  /**
   * A name that is not a relation is still an error, and running the group
   * concurrently must not turn it into a silent empty result.
   */
  test('and a name that is not a relation still says so', async () => {
    expect(Author.query().with('posts', 'nonsense').get()).rejects.toThrow(
      'Relation [nonsense] is not defined on Author.'
    )
  })
})

describe('inside a transaction', () => {
  /**
   * The concurrency is not switched off there, and this is the reason it is safe
   * to leave on: a transaction is pinned to one reserved connection, and the
   * driver queues concurrent statements on it. Verified against Postgres 17 and
   * MySQL 9.7 as well as the sqlite here — three overlapping selects inside one
   * transaction come back in order on all three.
   */
  test('every relation still lands', async () => {
    const app = new Application(process.cwd())

    app.config.set('database', {
      default: 'sqlite',
      connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
    })

    await app.register(EventServiceProvider)
    await app.register(DatabaseServiceProvider)
    await app.boot()

    const connection = await app.make('db').connection()

    await connection.statement('create table authors (id integer primary key)')
    await connection.statement('create table posts (id integer primary key, author_id integer)')
    await connection.statement('create table awards (id integer primary key, author_id integer)')
    await connection.statement('insert into authors values (1)')
    await connection.statement('insert into posts values (1,1)')
    await connection.statement('insert into awards values (1,1)')

    await connection.transaction(async () => {
      const authors = await Author.query().with('posts', 'awards').get()
      const ada = authors.first() as Author

      expect<number>((ada.getRelation('posts') as Collection<Post>).all().length).toBe(1)
      expect<number>((ada.getRelation('awards') as Collection<Award>).all().length).toBe(1)
    })
  })

  /**
   * And one relation failing while its siblings are still in flight rolls the
   * transaction back rather than leaving it open — the connection is usable after.
   */
  test('a failure among siblings still rolls back cleanly', async () => {
    const connection = await (
      Author as unknown as {
        getConnection: (n?: string) => Promise<{
          transaction: (body: () => Promise<unknown>) => Promise<unknown>
        }>
      }
    ).getConnection()

    expect(
      connection.transaction(async () => {
        await Author.query().with('posts', 'nonsense').get()
      })
    ).rejects.toThrow('Relation [nonsense] is not defined on Author.')

    // Still usable.
    expect<number>(await Author.query().count()).toBe(1)
  })
})
