import { controller } from '@elysian/core'
import { sessionOf, validateRequest } from '@elysian/http'
import { t } from 'elysia'
import { StoreArticleRequest } from '../Requests/StoreArticleRequest.ts'
import { ArticleResource } from '../Resources/ArticleResource.ts'

const ARTICLES: ArticleResource['resource'][] = [
  { id: 1, title: 'First', status: 'published', secret_notes: 'internal only' },
  {
    id: 2,
    title: 'Second',
    status: 'draft',
    secret_notes: 'wip',
    relationLoaded: (name) => name === 'comments',
    comments: [{ id: 9, body: 'Nice' }]
  }
]

/**
 * Exercise surface for `@elysian/http`, asserted by `scripts/smoke.ts`.
 *
 * These routes sit under `/check/*`, which the playground exempts from CSRF —
 * the CSRF path itself is exercised by `/session/*` below.
 */
export default controller('article')
  .post(
    '/check/articles',
    async (context) => {
      // A ValidationError becomes a 422 with the bag; a ForbiddenException a 403.
      // Both are rendered by HttpServiceProvider, so the handler stays this short.
      const data = await validateRequest(StoreArticleRequest, { body: context.body })

      return { created: data }
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        body: t.Optional(t.String()),
        status: t.Optional(t.String()),
        published_at: t.Optional(t.String()),
        forbidden: t.Optional(t.String())
      })
    }
  )

  .get('/check/articles', () => ArticleResource.collection(ARTICLES).withMeta({ total: 2 }))

  .get('/check/articles/:id', ({ params, query }) => {
    const article = ARTICLES.find((candidate) => candidate.id === Number(params.id))
    if (!article) return { data: null }

    return new ArticleResource(article, query.editor === 'yes').toObjectWithWrapper()
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
