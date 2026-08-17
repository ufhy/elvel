import { cache, LockTimeoutError, limiter } from '@elyvel/cache'
import { controller } from '@elyvel/core'
import { Article } from '../../Models/Article.ts'

/**
 * Generated with `bun run playground make:controller CacheController`, then
 * extended.
 *
 * Every driver is reachable here: `?store=redis` (or `array`, `file`,
 * `database`) picks one, so the same routes exercise all four. Asserted by
 * `scripts/smoke.ts` and driven over the network with `artisan serve` + curl.
 */
export default controller('cache')
  /** `remember` around a real query: the second call does not touch the database. */
  .get('/check/cache/articles', async ({ query }) => {
    const store = typeof query.store === 'string' ? query.store : undefined
    const repository = cache(store)

    let queried = false

    const titles = await repository.remember('articles:titles', 60, async () => {
      queried = true

      return (await Article.query().orderBy('id').get()).all().map((article) => article.title)
    })

    return { titles, queried, store: store ?? 'default' }
  })

  .delete('/check/cache/articles', async ({ query }) => {
    const store = typeof query.store === 'string' ? query.store : undefined

    return { forgotten: await cache(store).forget('articles:titles') }
  })

  /** Reads and writes, including the parts that are easy to get wrong. */
  .get('/check/cache/basics', async ({ query }) => {
    const repository = cache(typeof query.store === 'string' ? query.store : undefined)

    await repository.forget('probe')

    const first = await repository.add('probe', 'first', 60)
    const second = await repository.add('probe', 'second', 60)

    await repository.forget('counter')
    await repository.increment('counter')
    const counter = await repository.increment('counter', 4)

    // An object round-trips as data, not as its class.
    await repository.put('shape', { nested: { ok: true }, list: [1, 2] }, 60)

    return {
      // `add` is write-if-absent: the second call must not win.
      added: first,
      addedAgain: second,
      value: await repository.get<string>('probe'),
      counter,
      shape: await repository.get('shape'),
      pulled: await repository.pull<string>('probe'),
      afterPull: await repository.get('probe'),
      missing: await repository.get('never-written', 'fallback')
    }
  })

  /** Tags: one flush that leaves the neighbours alone. */
  .get('/check/cache/tags', async ({ query }) => {
    const repository = cache(typeof query.store === 'string' ? query.store : undefined)

    await repository.tags('people').put('ada', 'tagged-people', 60)
    await repository.tags('places').put('ada', 'tagged-places', 60)

    await repository.tags('people').flush()

    return {
      people: await repository.tags('people').get('ada'),
      places: await repository.tags('places').get<string>('ada')
    }
  })

  /**
   * An atomic lock. The second caller does not wait for the first — it is told
   * the section is busy, which is what a deploy or an import wants.
   */
  .post('/check/cache/lock', async ({ query, status }) => {
    const repository = cache(typeof query.store === 'string' ? query.store : undefined)

    const held = repository.lock('import', 10)

    if (!(await held.acquire())) {
      return status(409, { locked: true })
    }

    try {
      const contender = repository.lock('import', 10).betweenBlockedAttemptsSleepFor(20)

      let timedOut = false
      try {
        await contender.block(0.1)
      } catch (error) {
        timedOut = error instanceof LockTimeoutError
      }

      return { acquired: true, contenderTimedOut: timedOut, owner: held.owner().length }
    } finally {
      await held.release()
    }
  })

  /** Stale-while-revalidate: the stale value is served, the refresh is not awaited. */
  .get('/check/cache/flexible', async ({ query }) => {
    const repository = cache(typeof query.store === 'string' ? query.store : undefined)

    if (query.reset === 'yes') {
      await repository.forget('flexible:value')
      await repository.forget('elyvel:cache:flexible:created:flexible:value')
    }

    const value = await repository.flexible('flexible:value', [1, 60], () => Date.now())

    return { value, age: Date.now() - Number(value) }
  })

  /** The rate limiter, on whichever store `cache.limiter` names. */
  .post('/check/cache/limit', async ({ status }) => {
    const allowed = await limiter().attempt('playground:limit', 2, () => 'ran', 60)

    if (allowed === false) {
      return status(429, {
        limited: true,
        retryAfter: await limiter().availableIn('playground:limit')
      })
    }

    return { ran: allowed, remaining: await limiter().remaining('playground:limit', 2) }
  })

  .delete('/check/cache/limit', async () => {
    await limiter().clear('playground:limit')

    return { cleared: true }
  })

  /**
   * A semaphore, over whichever store is named — `?store=redis&hold=120`.
   *
   * Each request takes a slot, holds it for `hold` milliseconds and reports the
   * highest number that were inside together. Run several at once and the peak
   * must never exceed the limit, whichever driver is behind it.
   */
  .post('/check/cache/funnel', async ({ query }) => {
    const repository = cache(typeof query.store === 'string' ? query.store : undefined)
    const hold = Number(query.hold ?? 120)
    const slots = Number(query.limit ?? 2)

    const entered = await repository
      .funnel('playground:funnel')
      .limit(slots)
      .releaseAfter(30)
      .then(async () => {
        const inside = (await repository.increment('playground:funnel:inside')) as number

        // The peak is kept in the cache rather than in this process: with more
        // than one worker, a counter in memory would report each one's own view.
        const peak = Number((await repository.get('playground:funnel:peak')) ?? 0)
        if (inside > peak) await repository.forever('playground:funnel:peak', inside)

        await Bun.sleep(hold)
        await repository.decrement('playground:funnel:inside')

        return true
      })

    return {
      entered: entered !== false,
      peak: Number((await repository.get('playground:funnel:peak')) ?? 0)
    }
  })

  .delete('/check/cache/funnel', async ({ query }) => {
    const repository = cache(typeof query.store === 'string' ? query.store : undefined)

    await repository.forget('playground:funnel:inside')
    await repository.forget('playground:funnel:peak')

    return { cleared: true }
  })
