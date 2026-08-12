import { cache } from '@elysian/cache'
import { controller, defer, NotFoundException } from '@elysian/core'
import { chain, dispatch, dispatchSync, queue } from '@elysian/queue'
import { t } from 'elysia'
import { FlakyProbe } from '../../Jobs/FlakyProbe.ts'
import { SendArticleDigest } from '../../Jobs/SendArticleDigest.ts'
import { TouchArticle } from '../../Jobs/TouchArticle.ts'
import { Article } from '../../Models/Article.ts'

/**
 * Generated with `bun run playground make:controller QueueController`, then
 * extended.
 *
 * The request only ever *queues* work here; running it is `artisan queue:work`.
 * Pass `?connection=redis` (or `sync`, `database`) to move the same routes onto
 * another driver. Asserted by `scripts/smoke.ts` and driven over the network.
 */
export default controller('queue')
  /** Queue one job and return immediately — the whole point of a queue. */
  .post(
    '/check/queue/digest',
    async ({ body, query }) => {
      const connection = typeof query.connection === 'string' ? query.connection : undefined

      const id = await dispatch(
        new SendArticleDigest({
          label: body.label ?? 'digest',
          failOnPurpose: body.fail === true
        }),
        { connection, delay: body.delay, queue: body.queue }
      )

      return { queued: id, size: await queue().connection(connection).size(body.queue) }
    },
    {
      body: t.Object({
        label: t.Optional(t.String()),
        fail: t.Optional(t.Boolean()),
        delay: t.Optional(t.Number()),
        queue: t.Optional(t.String())
      })
    }
  )

  /**
   * A job that fails its first `failTimes` attempts, retried without a backoff so
   * the whole policy — retry, then fail, then the `failed()` hook — is observable
   * in one request.
   */
  .post(
    '/check/queue/flaky',
    async ({ body, query }) => {
      const connection = typeof query.connection === 'string' ? query.connection : undefined

      return {
        queued: await dispatch(
          new FlakyProbe({ label: body.label ?? 'probe', failTimes: body.failTimes ?? 1 }),
          { connection }
        )
      }
    },
    { body: t.Object({ label: t.Optional(t.String()), failTimes: t.Optional(t.Number()) }) }
  )

  /** Bypass the queue: run it here, and answer with the result in hand. */
  .post('/check/queue/digest/now', async ({ body }) => {
    await dispatchSync(
      new SendArticleDigest({ label: (body as { label?: string })?.label ?? 'now' })
    )

    return { log: await cache().get<string[]>('digest:log') }
  })

  /** A chain: each link is queued only once its predecessor has succeeded. */
  .post('/check/queue/chain', async ({ query }) => {
    const connection = typeof query.connection === 'string' ? query.connection : undefined

    const id = await chain(
      [
        new SendArticleDigest({ label: 'one' }),
        new SendArticleDigest({ label: 'two' }),
        new SendArticleDigest({ label: 'three' })
      ],
      { connection }
    )

    return { queued: id }
  })

  /**
   * A job carrying a model. The payload holds the key; the worker re-reads the
   * row, so it sees the current one.
   */
  .post('/check/queue/touch/:id', async ({ params, query }) => {
    const article = await Article.find(Number(params.id))
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    const connection = typeof query.connection === 'string' ? query.connection : undefined

    return { queued: await dispatch(new TouchArticle({ article, suffix: '!' }), { connection }) }
  })

  /** Run whatever is waiting, without leaving the process. */
  .post('/check/queue/work', async ({ query }) => {
    const connection = typeof query.connection === 'string' ? query.connection : undefined

    const result = await queue()
      .worker(connection)
      .work(typeof query.queue === 'string' ? query.queue : undefined, {
        maxTries: 3,
        stopWhenEmpty: true,
        sleep: 0
      })

    return { ...result, log: await cache().get<string[]>('digest:log') }
  })

  .get('/check/queue/state', async ({ query }) => {
    const connection = typeof query.connection === 'string' ? query.connection : undefined
    const failed = await queue().failed.all()

    return {
      size: await queue().connection(connection).size(),
      failed: failed.map((record) => ({
        id: record.id,
        job: record.payload.displayName,
        attempts: record.payload.attempts
      })),
      log: (await cache().get<string[]>('digest:log')) ?? [],
      jobs: queue().jobs.names()
    }
  })

  .delete('/check/queue/state', async ({ query }) => {
    const connection = typeof query.connection === 'string' ? query.connection : undefined

    await queue().connection(connection).clear()
    await queue().failed.flush()
    await cache().forget('digest:log')

    return { cleared: true }
  })

  /** Retry everything in the failed table, as `queue:retry all` does. */
  .post('/check/queue/retry', async () => {
    const failed = await queue().failed.all()

    for (const record of failed) await queue().retry(record.id)

    return { retried: failed.length }
  })

  /**
   * `defer()`: the work runs after the response has been sent, so this handler
   * returns before the cache is written.
   */
  .post('/check/queue/defer', async () => {
    await cache().forget('defer:ran')

    defer(async () => {
      await cache().forever('defer:ran', true)
    })

    return { deferred: true, ranAlready: await cache().get<boolean>('defer:ran') }
  })

  .get('/check/queue/defer', async () => ({
    ran: (await cache().get<boolean>('defer:ran')) ?? false
  }))
