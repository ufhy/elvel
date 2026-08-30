import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { EventServiceProvider } from '@elvel/events'
import type { Collection } from '@elvel/support'
import type { Connection } from '../src/connection/connection.ts'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

/**
 * `paginate()` issues its count and its page together.
 *
 * They are two queries against two clones and neither reads the other's answer,
 * so the only thing the sequencing bought was a round trip. What that costs is
 * easy to see and what it could break is not, which is what this file is for: the
 * result has to be the same result, in a transaction as well as out of one, and a
 * failure in either half still has to surface.
 */
class Person extends Model {
  static override table = 'people'
  static override timestamps = false

  declare id: number
  declare name: string
}

class Article extends Model {
  static override table = 'articles'
  static override timestamps = false

  declare id: number
  declare author_id: number

  author() {
    return this.belongsTo(Person, 'author_id', 'id')
  }
}

let connection: Connection

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

  await connection.statement('create table people (id integer primary key, name text)')
  await connection.statement('create table articles (id integer primary key, author_id integer)')
  await connection.statement("insert into people values (1,'Ada'),(2,'Grace')")

  for (let id = 1; id <= 7; id++) {
    await connection.statement(`insert into articles values (${id}, ${(id % 2) + 1})`)
  }
})

describe('a page and its count come back together', () => {
  test('the page is the page and the total is the total', async () => {
    const page = await Article.query().orderBy('id').paginate(2, 3)

    expect<number[]>(page.data.pluck('id').all() as number[]).toEqual([4, 5, 6])
    expect(page).toMatchObject({ total: 7, perPage: 3, currentPage: 2, lastPage: 3 })
  })

  /**
   * The eager load runs inside the page half, so it now overlaps the count. Every
   * article still has to arrive with its author.
   */
  test('an eager load on the page still lands', async () => {
    const page = await Article.query().with('author').orderBy('id').paginate(1, 3)

    const names = page.data.all().map((article) => (article.getRelation('author') as Person).name)

    expect<string[]>(names).toEqual(['Grace', 'Ada', 'Grace'])
    expect<number>(page.total).toBe(7)
  })

  /** Both halves share one reserved connection here, and both still answer. */
  test('inside a transaction as well', async () => {
    await connection.transaction(async () => {
      const page = await Article.query().orderBy('id').paginate(1, 2)

      expect<number[]>(page.data.pluck('id').all() as number[]).toEqual([1, 2])
      expect<number>(page.total).toBe(7)
    })
  })

  /**
   * A page past the end is an empty page with a real total, not an error — and
   * running the two queries concurrently must not turn the empty half into one.
   */
  test('a page past the end is empty and still counted', async () => {
    const page = await Article.query().paginate(99, 3)

    expect<number>((page.data as Collection<Article>).all().length).toBe(0)
    expect(page).toMatchObject({ total: 7, currentPage: 99, lastPage: 3 })
  })

  /**
   * A failure in either half surfaces rather than being swallowed by the other.
   *
   * A missing table rather than a missing column: SQLite resolves an unknown
   * double-quoted identifier to a string literal instead of erroring, so a typo'd
   * column is a valid query that matches nothing — which would have made this
   * test pass without ever reaching an error.
   */
  test('a broken query still throws', async () => {
    await connection.statement('drop table articles')

    await expect(Article.query().paginate(1, 3)).rejects.toThrow()
  })
})
