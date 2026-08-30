import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { EventServiceProvider } from '@elvel/events'
import type { Connection } from '../src/connection/connection.ts'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

/**
 * `static touches`, and the three things it could not do.
 *
 * It bumped one row per query, so attaching a tag an article shared with two
 * hundred others issued two hundred updates — and each was a full `save()`, which
 * fired two hundred sets of model events for a timestamp. It threw outright when
 * the named relation had more than one row on the other side, because `get()`
 * hands back a `Collection` and a `Collection` has no `touch`. And two models
 * that touched each other never stopped.
 *
 * Laravel does all of this with `Relation::touch()` — one `rawUpdate`, no events —
 * and guards the walk with `withoutRecursion`.
 */
class Thread extends Model {
  static override table = 'threads'

  declare id: number
  declare updated_at: string
}

class Post extends Model {
  static override table = 'posts'
  static override touches = ['thread']

  declare id: number
  declare thread_id: number

  thread() {
    return this.belongsTo(Thread, 'thread_id', 'id')
  }
}

class Comment extends Model {
  static override table = 'comments'
  static override touches = ['posts']

  declare id: number

  posts() {
    return this.belongsToMany(Post, 'comment_post', 'comment_id', 'post_id')
  }
}

/** Two models that name each other, which used to be an infinite walk. */
class Left extends Model {
  static override table = 'lefts'
  static override touches = ['right']

  declare id: number
  declare right_id: number

  right() {
    return this.belongsTo(Right, 'right_id', 'id')
  }
}

class Right extends Model {
  static override table = 'rights'
  static override touches = ['left']

  declare id: number
  declare left_id: number

  left() {
    return this.belongsTo(Left, 'left_id', 'id')
  }
}

/** A related model that keeps no timestamps has nothing to bump. */
class Stamp extends Model {
  static override table = 'stamps'
  static override timestamps = false

  declare id: number
}

class Sticker extends Model {
  static override table = 'stickers'
  static override touches = ['stamp']

  declare id: number
  declare stamp_id: number

  stamp() {
    return this.belongsTo(Stamp, 'stamp_id', 'id')
  }
}

let connection: Connection
let statements: string[] = []

const updates = () => statements.filter((sql) => sql.startsWith('update'))

const stamped = (table: string, id: number) =>
  connection
    .select(`select updated_at from ${table} where id = ${id}`)
    .then((rows) => String((rows[0] as Record<string, unknown>)?.updated_at))

beforeEach(async () => {
  const app = new Application(process.cwd())

  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  await app.register(EventServiceProvider)
  await app.register(DatabaseServiceProvider)
  await app.boot()

  connection = await app.make('db').connection()

  const stamps = 'created_at text, updated_at text'
  const old = "'2020-01-01 00:00:00'"

  await connection.statement(`create table threads (id integer primary key, ${stamps})`)
  await connection.statement(
    `create table posts (id integer primary key, thread_id integer, ${stamps})`
  )
  await connection.statement(`create table comments (id integer primary key, ${stamps})`)
  await connection.statement('create table comment_post (comment_id integer, post_id integer)')
  await connection.statement(
    `create table lefts (id integer primary key, right_id integer, ${stamps})`
  )
  await connection.statement(
    `create table rights (id integer primary key, left_id integer, ${stamps})`
  )
  await connection.statement('create table stamps (id integer primary key)')
  await connection.statement(
    `create table stickers (id integer primary key, stamp_id integer, ${stamps})`
  )

  await connection.statement(`insert into threads values (1, ${old}, ${old})`)

  for (let id = 1; id <= 3; id++) {
    await connection.statement(`insert into posts values (${id}, 1, ${old}, ${old})`)
    await connection.statement(`insert into comment_post values (1, ${id})`)
  }

  await connection.statement(`insert into comments values (1, ${old}, ${old})`)
  await connection.statement(`insert into lefts values (1, 1, ${old}, ${old})`)
  await connection.statement(`insert into rights values (1, 1, ${old}, ${old})`)
  await connection.statement('insert into stamps values (1)')
  await connection.statement(`insert into stickers values (1, 1, ${old}, ${old})`)

  statements = []
  app.make('db').listen((query) => statements.push(query.sql))
})

describe('touching a relation with many rows behind it', () => {
  /** This threw a TypeError before: a Collection has no `touch`. */
  test('does not throw, and bumps all of them', async () => {
    const comment = (await Comment.query().find(1)) as Comment

    await comment.save()

    for (const id of [1, 2, 3]) {
      expect<string>(await stamped('posts', id)).not.toBe('2020-01-01 00:00:00')
    }
  })

  test('with one update rather than one per row', async () => {
    const comment = (await Comment.query().find(1)) as Comment

    await comment.save()

    // The comment's own row, and one for all three posts.
    expect<number>(updates().filter((sql) => sql.includes('"posts"')).length).toBe(1)
  })
})

describe('the chain still walks', () => {
  /**
   * A comment touches its posts, and a post touches its thread. Bumping the
   * comment has to reach the thread, or `touches` would stop being transitive the
   * moment the middle step became a bulk update.
   */
  test('a touch two relations away still lands', async () => {
    const comment = (await Comment.query().find(1)) as Comment

    await comment.save()

    expect<string>(await stamped('threads', 1)).not.toBe('2020-01-01 00:00:00')
  })

  /** And it is not walked at all when the far side names nothing. */
  test('a relation whose model touches nothing is not read back', async () => {
    const post = (await Post.query().find(1)) as Post

    statements = []
    await post.save()

    expect<boolean>(statements.some((sql) => sql.startsWith('select'))).toBe(false)
  })
})

describe('two models that touch each other', () => {
  /** Without a guard this never returns. */
  test('stop', async () => {
    const left = (await Left.query().find(1)) as Left

    await left.save()

    expect<string>(await stamped('rights', 1)).not.toBe('2020-01-01 00:00:00')
  })
})

describe('a related model that keeps no timestamps', () => {
  test('is not written to', async () => {
    const sticker = (await Sticker.query().find(1)) as Sticker

    await sticker.save()

    expect<boolean>(updates().some((sql) => sql.includes('"stamps"'))).toBe(false)
  })
})
