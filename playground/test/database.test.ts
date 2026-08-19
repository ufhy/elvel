import { beforeEach, describe, expect, test as it } from 'bun:test'
import app from '../bootstrap/app.ts'
import './database.ts'
import { Article } from '../app/Models/Article.ts'

/**
 * The model layer, against a database of the tests' own.
 *
 * Importing `bootstrap/app.ts` for its side effect is the whole setup: the
 * providers have run, so `Article.query()` already knows which connection to use.
 * A test that built its own connection would be testing the query builder rather
 * than the application's configuration of it, and the two have disagreed before.
 */
let slug: string

beforeEach(() => {
  // Unique per test: `slug` is unique in the schema, and a fixed value makes a
  // test that passes once and fails for ever afterwards.
  slug = `test-${Date.now()}-${Math.round(performance.now() * 1000)}`
})

describe('reading', () => {
  it('finds a row and hydrates it as a model', async () => {
    const article = await Article.query().find(1)

    expect(article).toBeDefined()
    expect(typeof article?.title).toBe('string')
  })

  it('and answers undefined rather than throwing when there is none', async () => {
    expect(await Article.query().find(99_999)).toBeUndefined()
  })

  it('findOrFail throws, which is what a route binding wants', async () => {
    await expect(Article.query().findOrFail(99_999)).rejects.toThrow()
  })
})

describe('writing', () => {
  it('creates, reads back, updates and deletes', async () => {
    const created = await Article.create({
      title: 'From a test',
      slug,
      body: 'Long enough to satisfy whatever the rules ask for.',
      status: 'draft'
    })

    expect(created.id).toBeGreaterThan(0)

    const found = await Article.query().find(created.id)
    expect(found?.slug).toBe(slug)

    created.title = 'Renamed by a test'
    await created.save()

    expect((await Article.query().find(created.id))?.title).toBe('Renamed by a test')

    await created.delete()
  })

  /**
   * Soft deletes hide rows rather than removing them.
   *
   * The check that matters is the second one: a soft-deleted row must be
   * unreachable through the ordinary query, or "deleted" means nothing. The
   * first only proves the column was written.
   */
  it('a soft delete hides the row from the ordinary query', async () => {
    const article = await Article.create({
      title: 'To be deleted',
      slug,
      body: 'Long enough to satisfy whatever the rules ask for.',
      status: 'draft'
    })

    await article.delete()

    expect(await Article.query().find(article.id)).toBeUndefined()
    expect(await Article.query().withTrashed().find(article.id)).toBeDefined()

    await article.restore()
    expect(await Article.query().find(article.id)).toBeDefined()

    await article.forceDelete()
    expect(await Article.query().withTrashed().find(article.id)).toBeUndefined()
  })
})

describe('casts', () => {
  /**
   * A cast is only worth having if it survives the round trip.
   *
   * SQLite stores a boolean as 0 or 1 and JSON as text; reading them back as a
   * boolean and an object is the entire point, and asserting only on the write
   * would pass for a cast that has no `get`.
   */
  it('a boolean and a JSON column come back as themselves', async () => {
    const article = await Article.create({
      title: 'Cast test',
      slug,
      body: 'Long enough to satisfy whatever the rules ask for.',
      status: 'draft',
      featured: true,
      meta: { source: 'test', tags: ['a', 'b'] }
    })

    const read = await Article.query().find(article.id)

    expect(read?.featured).toBe(true)
    expect(read?.meta).toEqual({ source: 'test', tags: ['a', 'b'] })

    await article.forceDelete()
  })
})

describe('the query builder', () => {
  it('counts, orders and limits', async () => {
    const total = await Article.query().count()
    expect(total).toBeGreaterThan(0)

    const newest = await Article.query().orderByDesc('id').limit(2).get()
    expect(newest.count()).toBeLessThanOrEqual(2)
  })

  it('a collection comes back, not an array', async () => {
    const articles = await Article.query().limit(3).get()

    // `pluck` and friends are the reason: a plain array would make every caller
    // reach for a helper the framework already has.
    expect(articles.pluck('id').all().length).toBe(articles.count())
  })
})

describe('which database the tests use', () => {
  it('is the testing one, not the application’s', () => {
    /**
     * Not decoration. These tests migrate and seed, and the application's own
     * database is also read by `bun run smoke` and by a running `elvel serve`
     * — two processes on one SQLite file, where the second is refused outright
     * and fifteen tests fail together with `database is locked`. That is how
     * this was found.
     *
     * WAL and a busy timeout, added at the same time, make the collision
     * survivable; a database of its own is what stops it happening.
     */
    const connection = app.config.get<string>('database.default', 'sqlite')
    const path = app.config.get<string>(`database.connections.${connection}.database`, '')

    expect(path).toContain('testing.sqlite')
    expect(path).not.toContain('playground.sqlite')
  })
})
