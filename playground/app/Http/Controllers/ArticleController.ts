import { controller, NotFoundException } from '@elysian/core'
import { sessionOf, validateRequest } from '@elysian/http'
import { t } from 'elysia'
import { Article } from '../../Models/Article.ts'
import { StoreArticleRequest } from '../Requests/StoreArticleRequest.ts'
import { StoreOrderRequest } from '../Requests/StoreOrderRequest.ts'
import { ArticleResource } from '../Resources/ArticleResource.ts'

/**
 * Where the packages meet: a form request validates, a model persists, and a
 * resource serialises. Asserted by `scripts/smoke.ts`, and exercised by hand
 * with `artisan serve` + curl.
 *
 * These routes sit under `/check/*`, which the playground exempts from CSRF; the
 * CSRF path itself is exercised by `/session/*` below.
 */
export default controller('article')
  /** Paginated, with a relation count, straight through the model. */
  .get('/check/articles', async ({ query }) => {
    const articles = Article.query().withCount('comments').orderBy('id')

    if (query.published === 'yes') articles.scope('published')

    const page = await articles.paginate(Number(query.page ?? 1), Number(query.perPage ?? 15))

    return ArticleResource.collection(page.data)
      .withMeta({
        total: page.total,
        currentPage: page.currentPage,
        lastPage: page.lastPage
      })
      .toObjectWithWrapper()
  })

  /**
   * A payload with a variable number of lines, checked by wildcard rules.
   *
   * `parse: 'none'`-free and deliberately untyped by TypeBox: phase two is what
   * is being exercised here, and the errors come back keyed by the concrete path
   * (`lines.1.quantity`) so a form can put each message beside its own field.
   */
  .post('/check/orders', async (context) => {
    const data = await validateRequest(StoreOrderRequest, { body: context.body })

    return { validated: data }
  })

  /** Eager loading: one extra query for every article's comments, not N. */
  .get('/check/articles/with-comments', async () => {
    const articles = await Article.with('comments').orderBy('id').get()

    return ArticleResource.collection(articles).toObjectWithWrapper()
  })

  .get('/check/articles/:id', async ({ params, query }) => {
    const article = await Article.find(Number(params.id))

    // A missing row is a 404, rendered by the framework's exception handler.
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    if (query.withComments === 'yes') await article.load('comments')

    return new ArticleResource(article, query.editor === 'yes').toObjectWithWrapper()
  })

  /** Validate, then create — the two packages in one handler. */
  .post(
    '/check/articles',
    async (context) => {
      const data = await validateRequest(StoreArticleRequest, { body: context.body })
      const article = await Article.create(data)

      return context.status(201, new ArticleResource(article, true).toObjectWithWrapper())
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        slug: t.Optional(t.String()),
        body: t.Optional(t.String()),
        status: t.Optional(t.String()),
        published_at: t.Optional(t.String()),
        forbidden: t.Optional(t.String())
      })
    }
  )

  /** Soft delete: the row survives, the default query stops seeing it. */
  .delete('/check/articles/:id', async ({ params }) => {
    const article = await Article.find(Number(params.id))
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    await article.delete()

    return {
      trashed: article.trashed(),
      visible: await Article.query().count(),
      withTrashed: await Article.withTrashed().count()
    }
  })

  .post('/check/articles/:id/restore', async ({ params }) => {
    const article = await Article.withTrashed().find(Number(params.id))
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    await article.restore()

    return { trashed: article.trashed(), visible: await Article.query().count() }
  })

  /**
   * Sessions and CSRF: this path is deliberately *not* exempt.
   *
   * `sessionOf(context)` is used rather than destructuring `session`: the derive
   * is registered globally by the provider, and Elysia types a context from the
   * plugins the instance itself uses. That narrowing lives in one place.
   */
  .get('/session/token', (context) => {
    const session = sessionOf(context)

    return { token: session.token(), visits: session.get<number>('visits', 0) }
  })

  .post('/session/visit', (context) => {
    const session = sessionOf(context)

    session.put('visits', session.get<number>('visits', 0) + 1)
    session.flash('status', 'Visited!')

    return { visits: session.get<number>('visits', 0) }
  })

  .get('/session/status', (context) => ({
    status: sessionOf(context).get('status') ?? null
  }))
