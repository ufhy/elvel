import { controller, NotFoundException } from '@elvel/core'
import { redirect, route, routes, sessionOf, validateRequest } from '@elvel/http'
import { t } from 'elysia'
import { Article } from '../../Models/Article.ts'
import type { Comment } from '../../Models/Comment.ts'
import { Tag } from '../../Models/Tag.ts'
import { StoreArticleRequest } from '../Requests/StoreArticleRequest.ts'
import { StoreOrderRequest } from '../Requests/StoreOrderRequest.ts'
import { ArticleResource } from '../Resources/ArticleResource.ts'

/**
 * Where the packages meet: a form request validates, a model persists, and a
 * resource serialises. Asserted by `scripts/smoke.ts`, and exercised by hand
 * with `elvel serve` + curl.
 *
 * These routes sit under `/check/*`, which the playground exempts from CSRF; the
 * CSRF path itself is exercised by `/session/*` below.
 */
/**
 * Names for the routes other code links to.
 *
 * Registered here, beside the routes themselves, so a path and its name change
 * together — and `verify()` refuses to boot if they ever stop matching.
 */
routes().names({
  'articles.index': '/check/articles',
  'articles.show': '/check/articles/:id',
  'articles.restore': '/check/articles/:id/restore'
})

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

  /**
   * Tags through a polymorphic pivot, with the extra columns read back.
   *
   * The pivot's own data — who attached the tag, and when — lives on
   * `tag.pivot`, not on the tag, which is what stops a pivot column from
   * overwriting a column of the same name on the model.
   */
  .post(
    '/check/articles/:id/tags',
    async ({ params, body }) => {
      const article = await Article.find(Number(params.id))
      if (!article) throw new NotFoundException(`No article [${params.id}].`)

      const tag =
        (await Tag.query().where('label', body.label).first()) ??
        (await Tag.create({ label: body.label }))

      await article.tags().attach(tag.id, { added_by: body.addedBy ?? 'nobody' })

      const tags = await article.tags().get()

      return {
        tags: tags.all().map((entry) => {
          const pivot = entry.getRelation('pivot') as { attributes: Record<string, unknown> }

          return {
            label: entry.label,
            addedBy: pivot.attributes.added_by,
            type: pivot.attributes.taggable_type,
            attachedAt: pivot.attributes.created_at
          }
        })
      }
    },
    { body: t.Object({ label: t.String(), addedBy: t.Optional(t.String()) }) }
  )

  /** The inverse: which articles carry this tag. */
  .get('/check/tags/:label/articles', async ({ params }) => {
    const tag = await Tag.query().where('label', params.label).first()
    if (!tag) throw new NotFoundException(`No tag [${params.label}].`)

    const articles = await tag.articles().get()

    return { articles: articles.all().map((article) => article.title) }
  })

  /**
   * The newest comment per article, eagerly loaded.
   *
   * One query for every article, and each keeps its own row — which is what a
   * `limit 1` on the same query would get wrong.
   */
  /** URLs built from names, and a redirect that goes through one. */
  .get('/check/articles/links', ({ query }) => {
    if (query.redirect === 'yes') return redirect().route('articles.show', { id: 7 }).toResponse()

    return {
      index: route('articles.index', { page: 2 }),
      show: route('articles.show', { id: 7 }),
      absolute: route('articles.show', { id: 7 }, true),
      // A name nobody registered is an error at the call, not a broken link.
      unknown: (() => {
        try {
          route('articles.missing')

          return null
        } catch (error) {
          return (error as Error).message
        }
      })()
    }
  })

  .get('/check/articles/latest-comments', async () => {
    const articles = await Article.with('latestComment').orderBy('id').get()

    return {
      articles: articles.all().map((article) => ({
        id: article.id,
        latest: (article.getRelation('latestComment') as Comment | undefined)?.body ?? null
      }))
    }
  })

  /**
   * A page addressed by a cursor rather than a number.
   *
   * No total and no last page: knowing either costs a `count(*)` over the whole
   * table, which is the expense this exists to avoid. What it buys is a page that
   * cannot repeat or skip a row when something is inserted mid-read.
   */
  .get('/check/articles/cursor', async ({ query }) => {
    const page = await Article.query()
      .orderBy('id')
      .cursorPaginate(Number(query.perPage ?? 2), (query.cursor as string) ?? null)

    return {
      data: page.data.all().map((article) => ({ id: article.id, title: article.title })),
      nextCursor: page.nextCursor,
      previousCursor: page.previousCursor
    }
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

    // `ensureToken`, not `token`: this endpoint exists to hand one out, so the
    // session has to be given one and saved. A session that starts without a token
    // is what keeps a page with no form from writing anything at all.
    return { token: session.ensureToken(), visits: session.get<number>('visits', 0) }
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
