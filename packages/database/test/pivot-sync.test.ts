import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { EventServiceProvider } from '@elvel/events'
import type { Connection } from '../src/connection/connection.ts'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

/**
 * `sync()` changes what has to change, and nothing else.
 *
 * It used to delete every pivot row and reinsert the lot. The query count barely
 * moved, which is why this was easy to miss, but the pivot's `created_at` did not
 * survive: adding one tag to an article rewrote "when did this article get that
 * tag" for every tag it already carried. There is no recovering that from a
 * backup you did not know you needed.
 */
class Tag extends Model {
  static override table = 'tags'
  static override timestamps = false

  declare id: number
}

class Article extends Model {
  static override table = 'articles'
  static override timestamps = false

  declare id: number

  tags() {
    return this.belongsToMany(Tag, 'article_tag', 'article_id', 'tag_id')
      .withTimestamps()
      .named('tags')
  }
}

type Pivot = {
  sync(ids: unknown[], detaching?: boolean): Promise<{ attached: unknown[]; detached: unknown[] }>
  syncWithoutDetaching(ids: unknown[]): Promise<{ attached: unknown[] }>
  toggle(ids: unknown[]): Promise<{ attached: unknown[]; detached: unknown[] }>
}

let connection: Connection
let statements: string[] = []
let article: Article

const pivot = () => article.tags() as never as Pivot

const rows = () => connection.select('select tag_id, created_at from article_tag order by tag_id')

const kinds = () => statements.map((sql) => sql.slice(0, 6))

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

  await connection.statement('create table tags (id integer primary key)')
  await connection.statement('create table articles (id integer primary key)')
  await connection.statement(
    'create table article_tag (article_id integer, tag_id integer, created_at text, updated_at text)'
  )

  await connection.statement('insert into articles values (1)')

  for (const id of [1, 2, 3, 4]) await connection.statement(`insert into tags values (${id})`)

  // Two tags attached long ago, so a rewritten created_at is visible.
  for (const id of [1, 2]) {
    await connection.statement(
      `insert into article_tag values (1, ${id}, '2020-01-01 00:00:00', '2020-01-01 00:00:00')`
    )
  }

  article = (await Article.query().find(1)) as Article

  statements = []
  app.make('db').listen((query) => statements.push(query.sql))
})

describe('adding one tag', () => {
  test('leaves the other pivot rows exactly as they were', async () => {
    await pivot().sync([1, 2, 3])

    const stamps = (await rows()).map((row) => String(row.created_at).slice(0, 10))

    expect<string>(stamps[0] as string).toBe('2020-01-01')
    expect<string>(stamps[1] as string).toBe('2020-01-01')
    expect<boolean>(stamps[2] === '2020-01-01').toBe(false)
  })

  test('and inserts without deleting anything', async () => {
    await pivot().sync([1, 2, 3])

    expect<string[]>(kinds()).toEqual(['select', 'insert'])
  })

  test('reporting what it changed', async () => {
    const changed = await pivot().sync([1, 2, 3])

    expect<unknown[]>(changed.attached).toEqual([3])
    expect<unknown[]>(changed.detached).toEqual([])
  })
})

describe('a sync that changes nothing', () => {
  test('writes nothing', async () => {
    await pivot().sync([1, 2])

    expect<string[]>(kinds()).toEqual(['select'])
  })

  test('and says so', async () => {
    const changed = await pivot().sync([1, 2])

    expect<number>(changed.attached.length + changed.detached.length).toBe(0)
  })
})

describe('removing a tag', () => {
  test('deletes only that one', async () => {
    await pivot().sync([1])

    // Snapshotted before the assertion below reads the table through the same
    // connection, which the listener would otherwise count as a third query.
    const ran = kinds()

    expect<string[]>(ran).toEqual(['select', 'delete'])
    expect<unknown[]>((await rows()).map((row) => row.tag_id)).toEqual([1])
  })

  test('and the survivor keeps its date', async () => {
    await pivot().sync([1])

    expect<string>(String((await rows())[0]?.created_at).slice(0, 10)).toBe('2020-01-01')
  })
})

describe('syncWithoutDetaching', () => {
  test('adds without removing', async () => {
    const changed = await pivot().syncWithoutDetaching([3])

    expect<unknown[]>((await rows()).map((row) => row.tag_id)).toEqual([1, 2, 3])
    expect<unknown[]>(changed.attached).toEqual([3])
  })
})

describe('toggle', () => {
  test('flips each id and reports both halves', async () => {
    const changed = await pivot().toggle([2, 3])

    expect<unknown[]>((await rows()).map((row) => row.tag_id)).toEqual([1, 3])
    expect<unknown[]>(changed.attached).toEqual([3])
    expect<unknown[]>(changed.detached).toEqual([2])
  })

  test('and leaves the untouched row alone', async () => {
    await pivot().toggle([2, 3])

    const kept = (await rows()).find((row) => row.tag_id === 1)

    expect<string>(String(kept?.created_at).slice(0, 10)).toBe('2020-01-01')
  })
})

describe('the related rows are touched once', () => {
  /**
   * A sync is one change. It used to be a detach and an attach, each firing its
   * own touch, so a related model naming the inverse was bumped twice per sync.
   */
  test('not once per half', async () => {
    Tag.timestamps = true
    ;(Tag as unknown as { touches: string[] }).touches = ['articles']

    try {
      await connection.statement('drop table tags')
      await connection.statement(
        'create table tags (id integer primary key, created_at text, updated_at text)'
      )

      for (const id of [1, 2, 3, 4])
        await connection.statement(`insert into tags values (${id}, null, null)`)

      statements = []
      await pivot().sync([2, 3])

      const touched = statements.filter((sql) => sql.startsWith('update') && sql.includes('"tags"'))

      expect<number>(touched.length).toBe(1)
    } finally {
      Tag.timestamps = false
      ;(Tag as unknown as { touches: string[] }).touches = []
    }
  })
})
