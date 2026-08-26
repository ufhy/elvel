import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

/**
 * Querying a polymorphic relation — the thirteen `*Morph*` methods.
 *
 * The relations existed before this file and the queries did not, which is a
 * strange half: an application could declare `morphTo` and then had no way to ask
 * anything about it. `whereHas` refuses on a morphTo and is right to — one
 * `exists` cannot span tables — so these are the methods that do it, by
 * constraining the **type** column and running one subquery per type.
 *
 * The semantics come from `Illuminate\Database\Eloquent\Concerns\QueriesRelationships`:
 * `hasMorph` builds an `or` group of `(type = X and exists(…))` branches, and
 * `whereMorphedTo` groups models by type because two types share an id space by
 * accident.
 *
 * The fixtures are two genuinely different tables with different columns, which
 * is the only way to prove the per-type subquery: a constraint on `posts.body`
 * cannot be applied to `videos`, and a test with two identical tables would pass
 * either way.
 */
class Post extends Model {
  static override table = 'posts'
  static override timestamps = false

  declare id: number
  declare title: string
  declare body: string
}

class Video extends Model {
  static override table = 'videos'
  static override timestamps = false

  declare id: number
  declare title: string
  declare seconds: number
}

class Comment extends Model {
  static override table = 'comments'
  static override timestamps = false

  declare id: number
  declare commentable_type: string
  declare commentable_id: number
  declare body: string

  commentable() {
    return this.morphTo('commentable', { posts: Post, videos: Video })
  }

  /** Not a morphTo, for the test that the morph methods refuse one. */
  writer() {
    return this.belongsTo(Post, 'commentable_id', 'id')
  }
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

  await connection.statement('create table posts (id integer primary key, title text, body text)')
  await connection.statement(
    'create table videos (id integer primary key, title text, seconds integer)'
  )
  await connection.statement(
    'create table comments (id integer primary key, commentable_type text, commentable_id integer, body text)'
  )

  await connection.statement("insert into posts values (1,'Kept','long'),(2,'Gone','short')")
  await connection.statement("insert into videos values (1,'Clip',30),(2,'Film',7200)")

  /**
   * The ids collide across types on purpose.
   *
   * `posts` and `videos` both have a 1 and a 2, so any implementation that
   * constrains the id without its type answers the wrong row — and a test whose
   * fixtures did not collide would never notice.
   */
  await connection.statement(
    "insert into comments values (1,'posts',1,'on the kept post')," +
      "(2,'posts',2,'on the gone post')," +
      "(3,'videos',1,'on the clip')," +
      "(4,'videos',2,'on the film')," +
      "(5,'posts',99,'orphaned')," +
      "(6,NULL,NULL,'attached to nothing')"
  )
})

const bodies = async (query: {
  get: () => Promise<{ map: (fn: (row: Comment) => string) => { all: () => string[] } }>
}) =>
  (await query.get())
    .map((comment) => comment.body)
    .all()
    .sort()

describe('whereHasMorph', () => {
  test('crosses both tables, one subquery per type', async () => {
    const found = await bodies(Comment.query().whereHasMorph('commentable', [Post, Video]))

    // Every comment whose target exists: the orphan and the null one are out.
    expect<string[]>(found).toEqual([
      'on the clip',
      'on the film',
      'on the gone post',
      'on the kept post'
    ])
  })

  test('one type narrows it to that table', async () => {
    const found = await bodies(Comment.query().whereHasMorph('commentable', Video))

    expect<string[]>(found).toEqual(['on the clip', 'on the film'])
  })

  /**
   * The callback receives the type, which is the whole reason it does.
   *
   * `seconds` exists on `videos` and not on `posts`. A callback that could not
   * tell them apart would have to name only columns every type shares — and the
   * interesting constraints never are.
   */
  test('the callback is given the type, so a constraint can differ per table', async () => {
    const found = await bodies(
      Comment.query().whereHasMorph('commentable', [Post, Video], (query, type) => {
        if (type === 'videos') query.where('seconds', '>', 60)
        else query.where('body', 'long')
      })
    )

    expect<string[]>(found).toEqual(['on the film', 'on the kept post'])
  })

  test("'*' uses every type the relation declares", async () => {
    const found = await bodies(Comment.query().whereHasMorph('commentable', '*'))

    expect<string[]>(found).toEqual([
      'on the clip',
      'on the film',
      'on the gone post',
      'on the kept post'
    ])
  })

  test('whereDoesntHaveMorph finds the ones pointing at nothing that exists', async () => {
    const found = await bodies(Comment.query().whereDoesntHaveMorph('commentable', [Post, Video]))

    // The orphan: its type is known, its row is gone. The null one matches no
    // type branch at all, so it is not here either.
    expect<string[]>(found).toEqual(['orphaned'])
  })

  test('orWhereHasMorph joins with or', async () => {
    const found = await bodies(
      Comment.query().where('body', 'orphaned').orWhereHasMorph('commentable', Video)
    )

    expect<string[]>(found).toEqual(['on the clip', 'on the film', 'orphaned'])
  })

  test('hasMorph and doesntHaveMorph are the same without the where', async () => {
    expect<string[]>(await bodies(Comment.query().hasMorph('commentable', Video))).toEqual([
      'on the clip',
      'on the film'
    ])
    expect<string[]>(
      await bodies(Comment.query().doesntHaveMorph('commentable', [Post, Video]))
    ).toEqual(['orphaned'])
  })
})

describe('whereMorphedTo', () => {
  test('a model matches its type and its key together', async () => {
    const post = (await Post.query().find(1)) as Post
    const found = await bodies(Comment.query().whereMorphedTo('commentable', post))

    // Not the clip, whose id is also 1 — which is what grouping by type buys.
    expect<string[]>(found).toEqual(['on the kept post'])
  })

  test('several models are grouped by type, not flattened', async () => {
    const post = (await Post.query().find(1)) as Post
    const video = (await Video.query().find(2)) as Video

    const found = await bodies(Comment.query().whereMorphedTo('commentable', [post, video]))

    expect<string[]>(found).toEqual(['on the film', 'on the kept post'])
  })

  test('a type name on its own matches every row of that type', async () => {
    const found = await bodies(Comment.query().whereMorphedTo('commentable', 'videos'))

    expect<string[]>(found).toEqual(['on the clip', 'on the film'])
  })

  /**
   * `null` asks for the rows pointing at nothing.
   *
   * A comparison would never match: the column holds a type name or nothing at
   * all, so this has to become `is null`.
   */
  test('null finds the rows attached to nothing', async () => {
    const found = await bodies(Comment.query().whereMorphedTo('commentable', null))

    expect<string[]>(found).toEqual(['attached to nothing'])
  })

  test('whereNotMorphedTo is the negation, and keeps the null row out of it', async () => {
    const post = (await Post.query().find(1)) as Post
    const found = await bodies(Comment.query().whereNotMorphedTo('commentable', post))

    expect<boolean>(found.includes('on the kept post')).toBe(false)
    expect<boolean>(found.includes('on the clip')).toBe(true)
  })

  test('orWhereMorphedTo joins with or', async () => {
    const video = (await Video.query().find(1)) as Video
    const found = await bodies(
      Comment.query().where('body', 'orphaned').orWhereMorphedTo('commentable', video)
    )

    expect<string[]>(found).toEqual(['on the clip', 'orphaned'])
  })

  test('an empty list is refused rather than matching nothing quietly', async () => {
    expect(() => Comment.query().whereMorphedTo('commentable', [])).toThrow('empty list')
  })
})

describe('whereMorphRelation', () => {
  test('is whereHasMorph with the condition on the outside', async () => {
    const found = await bodies(
      Comment.query().whereMorphRelation('commentable', Post, 'body', 'long')
    )

    expect<string[]>(found).toEqual(['on the kept post'])
  })

  test('and the doesnt-have form negates it', async () => {
    const found = await bodies(
      Comment.query().whereMorphDoesntHaveRelation('commentable', Post, 'body', 'long')
    )

    // Both video comments and the orphan: none of them is a post with a long body.
    expect<boolean>(found.includes('on the kept post')).toBe(false)
    expect<boolean>(found.includes('on the gone post')).toBe(true)
  })
})

describe('what these refuse', () => {
  test('a relation that is not a morphTo, by name', () => {
    expect(() => Comment.query().whereHasMorph('writer', Post)).toThrow('is not a morphTo')
  })

  /**
   * And `whereHas` on a morphTo still refuses — but now it says what to use.
   *
   * "Not supported" without the alternative is where somebody gives up and writes
   * raw SQL.
   */
  test('whereHas on a morphTo names the method that does work', async () => {
    let message = ''

    try {
      await Comment.query().whereHas('commentable').get()
    } catch (problem) {
      message = problem instanceof Error ? problem.message : String(problem)
    }

    expect<boolean>(message.includes('whereHasMorph')).toBe(true)
  })
})
