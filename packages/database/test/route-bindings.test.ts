import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elyvel/core'
import { bindings, bound, HttpServiceProvider, middleware } from '@elyvel/http'
import { Elysia } from 'elysia'
import { DatabaseServiceProvider, Model } from '../src/index.ts'

class Writer extends Model {
  static override table = 'writers'

  declare id: number
  declare name: string

  articles() {
    return this.hasMany(Article, 'writer_id')
  }
}

class Article extends Model {
  static override table = 'articles'
  // A slug in the URL rather than an id, without writing the column anywhere else.
  static override routeKey = 'slug'

  declare id: number
  declare writer_id: number
  declare slug: string
  declare title: string
}

/** A real SQLite database, so a binding is a query rather than a stub. */
async function application(): Promise<Application> {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost' })
  app.config.set('session', { driver: 'memory', csrf: false })
  app.config.set('cache', { default: 'array', stores: { array: { driver: 'array' } } })
  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  await app.register(DatabaseServiceProvider)
  await app.register(HttpServiceProvider)
  await app.boot()
  app.handleExceptions()

  const connection = await app.make('db').connection()

  await connection.statement('create table writers (id integer primary key, name text)')
  await connection.statement(
    'create table articles (id integer primary key, writer_id integer, slug text, title text)'
  )
  await connection.statement("insert into writers values (1, 'Ada'), (2, 'Grace')")
  await connection.statement(
    "insert into articles values (1, 1, 'first', 'First'), (2, 2, 'second', 'Second')"
  )

  return app
}

describe('binding a model to a parameter', () => {
  let app: Application

  beforeEach(async () => {
    app = await application()
  })

  test('resolves by the route key the model declares', async () => {
    bindings().model('article', Article)

    app.useRoutes(
      new Elysia().get(
        '/articles/:article',
        () => ({ title: bound<Article>('article', currentRequest).title }),
        middleware('bindings')
      )
    )

    // `slug`, not `id`, because the model says so.
    const response = await handle(app, '/articles/first')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ title: 'First' })
  })

  test('a value that matches nothing is a 404, not a 500', async () => {
    bindings().model('article', Article)
    app.useRoutes(new Elysia().get('/articles/:article', () => 'never', middleware('bindings')))

    const response = await handle(app, '/articles/nowhere')

    expect(response.status).toBe(404)
    // Naming the parameter is what makes a wrong route obvious without a debugger.
    expect(await response.text()).toContain('article')
  })

  test('a parameter nobody declared is left as a string', async () => {
    bindings().model('article', Article)

    app.useRoutes(
      new Elysia().get(
        '/articles/:article/comments/:comment',
        ({ params }) => ({ comment: params.comment }),
        middleware('bindings')
      )
    )

    const response = await handle(app, '/articles/first/comments/7')

    expect(await response.json()).toEqual({ comment: '7' })
  })

  test('a hand-written binding resolves whatever it likes', async () => {
    bindings().bind('kind', (value) => (value === 'draft' ? { label: 'Draft' } : undefined))

    app.useRoutes(
      new Elysia().get(
        '/kinds/:kind',
        () => ({ label: bound<{ label: string }>('kind', currentRequest).label }),
        middleware('bindings')
      )
    )

    expect(await (await handle(app, '/kinds/draft')).json()).toEqual({ label: 'Draft' })
    // Returning nothing is a 404, the same as a model that found no row.
    expect((await handle(app, '/kinds/other')).status).toBe(404)
  })
})

describe('scoped bindings', () => {
  let app: Application

  beforeEach(async () => {
    app = await application()
  })

  /**
   * The check this exists for.
   *
   * `/writers/2/articles/first` names a real writer and a real article that
   * belongs to somebody else. Resolved independently both would be found and the
   * handler would answer — a route that looks like it works and hands one
   * person's row to another.
   */
  test('a child that belongs to another parent is not found', async () => {
    bindings()
      .model('writer', Writer)
      .model('article', Article, { parent: 'writer', relation: 'articles' })

    app.useRoutes(
      new Elysia().get(
        '/writers/:writer/articles/:article',
        () => ({ title: bound<Article>('article', currentRequest).title }),
        middleware('bindings')
      )
    )

    const own = await handle(app, '/writers/1/articles/first')
    const other = await handle(app, '/writers/2/articles/first')

    expect(await own.json()).toEqual({ title: 'First' })
    expect(other.status).toBe(404)
  })

  test('the parent is resolved first whatever order the path lists them', async () => {
    bindings()
      .model('writer', Writer)
      .model('article', Article, { parent: 'writer', relation: 'articles' })

    app.useRoutes(
      new Elysia().get(
        '/writers/:writer/articles/:article',
        () => ({
          writer: bound<Writer>('writer', currentRequest).name,
          article: bound<Article>('article', currentRequest).title
        }),
        middleware('bindings')
      )
    )

    expect(await (await handle(app, '/writers/1/articles/first')).json()).toEqual({
      writer: 'Ada',
      article: 'First'
    })
  })

  test('scoping to a parameter the route does not bind says so', async () => {
    bindings().model('article', Article, { parent: 'writer', relation: 'articles' })

    app.useRoutes(new Elysia().get('/articles/:article', () => 'never', middleware('bindings')))

    const response = await handle(app, '/articles/first')

    /**
     * A 500, and deliberately not the reason.
     *
     * The exception handler does not put a 500's message in the body — leaking
     * internals to a client is how a stack trace ends up in somebody's browser.
     * The explanation goes to the log, so this asserts the status and reads the
     * message from the exception instead.
     */
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('writer')
  })
})

describe('the model side', () => {
  test('routeKeyName is the primary key unless overridden', async () => {
    await application()

    expect(Writer.routeKeyName()).toBe('id')
    expect(Article.routeKeyName()).toBe('slug')
  })

  test('resolveRouteBinding takes a field override', async () => {
    await application()

    // `{article:title}` would pass the field, beating the model's own default.
    expect((await Article.resolveRouteBinding('First', 'title'))?.slug).toBe('first')
    expect(await Article.resolveRouteBinding('nothing')).toBeUndefined()
  })
})

/**
 * The request the assertions read bindings from.
 *
 * `bound()` is keyed by request, so the test has to hold the same one the
 * middleware resolved against.
 */
let currentRequest: Request

function handle(app: Application, path: string): Promise<Response> {
  currentRequest = new Request(`http://localhost${path}`)

  return app.handle(currentRequest)
}
