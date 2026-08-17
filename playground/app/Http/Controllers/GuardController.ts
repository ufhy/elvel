import { authorize, can, requireUser, user } from '@elyvel/auth'
import { controller, NotFoundException } from '@elyvel/core'
import { t } from 'elysia'
import { Article } from '../../Models/Article.ts'

/**
 * Generated with `bun run playground make:controller GuardController`, then
 * extended.
 *
 * Where auth meets authorization. None of these handlers receives the user as an
 * argument: `user()` reads it from the request scope, which is what lets a
 * policy — or a model, or anything called deeper — ask who is signed in.
 *
 * Sign in through better-auth's own endpoints first:
 *
 *   POST /api/auth/sign-up/email  {"name","email","password"}
 *   POST /api/auth/sign-in/email  {"email","password"}
 */
export default controller('guard')
  /** Who am I? A guest gets a 401 from `requireUser()`. */
  .get('/check/me', () => {
    const current = requireUser()

    return { id: current.id, email: current.email, verified: current.emailVerified === true }
  })

  /** The same route, without insisting on a session. */
  .get('/check/whoami', () => ({ email: user()?.email ?? null, guest: user() === null }))

  /** Abilities defined inline rather than through a policy. */
  .get('/check/abilities', async () => ({
    statusPage: await can('view-status-page'),
    admin: await can('access-admin')
  }))

  /**
   * `create` has no model instance to authorize against, so the class is passed
   * and the policy drops it — the same shape as Laravel's `authorize('create',
   * Article::class)`.
   */
  .post(
    '/check/guarded/articles',
    async ({ body, status }) => {
      await authorize('create', Article)

      const article = await Article.create({ ...body, author_id: requireUser().id })

      return status(201, { id: article.id, author_id: article.author_id })
    },
    {
      body: t.Object({
        title: t.String(),
        slug: t.String(),
        body: t.String(),
        status: t.Optional(t.String())
      })
    }
  )

  /** Ownership: the policy's message is what the client is told. */
  .put(
    '/check/guarded/articles/:id',
    async ({ params, body }) => {
      const article = await Article.find(Number(params.id))
      if (!article) throw new NotFoundException(`No article [${params.id}].`)

      await authorize('update', article)

      article.title = body.title
      await article.save()

      return { id: article.id, title: article.title }
    },
    { body: t.Object({ title: t.String() }) }
  )

  /**
   * A policy may deny as a 404: a 403 on someone else's article would confirm it
   * exists.
   */
  .delete('/check/guarded/articles/:id', async ({ params }) => {
    const article = await Article.find(Number(params.id))
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    await authorize('delete', article)
    await article.delete()

    return { trashed: article.trashed() }
  })
