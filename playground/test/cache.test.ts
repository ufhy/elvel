import { beforeEach, describe, expect, test as it } from 'bun:test'
import { cache } from '@elysian/cache'
import '../bootstrap/app.ts'

/**
 * The cache, against the store the application is configured with.
 *
 * Not a memory store built for the test: a `remember()` that works in memory and
 * fails on the file driver is a bug nobody sees until deployment, and the driver
 * an application runs is the one worth exercising.
 */
const key = (name: string) => `test:${name}:${Date.now()}:${Math.round(performance.now() * 1000)}`

beforeEach(async () => {
  // Not `flush()`: this store is shared with whatever else the process is doing,
  // and emptying it would make other tests fail for reasons of ours.
})

describe('the basics', () => {
  it('puts, gets and forgets', async () => {
    const k = key('basic')

    // `null` rather than `undefined` on a miss — the cache's own convention, and
    // deliberately not the model layer's, where `find()` answers `undefined`.
    expect(await cache().get(k)).toBeNull()

    await cache().put(k, 'value', 60)
    expect(await cache().get<string>(k)).toBe('value')

    await cache().forget(k)
    expect(await cache().get(k)).toBeNull()
  })

  it('a miss answers the default rather than throwing', async () => {
    expect(await cache().get(key('missing'), 'fallback')).toBe('fallback')
  })

  /**
   * `has()` and a stored `null`/`false` are different questions.
   *
   * A cache that answers "no" for a value it is holding sends the caller back to
   * the database every time — a stampede that looks like the cache being cold.
   */
  it('holds a false without losing it', async () => {
    const k = key('false')

    await cache().put(k, false, 60)

    expect(await cache().get<boolean>(k)).toBe(false)
    expect(await cache().has(k)).toBe(true)
  })
})

describe('remember', () => {
  it('computes once and serves the stored value after', async () => {
    const k = key('remember')
    let computed = 0

    const value = () =>
      cache().remember(k, 60, async () => {
        computed += 1

        return 'expensive'
      })

    expect(await value()).toBe('expensive')
    expect(await value()).toBe('expensive')

    // The point of the whole feature: the callback ran once.
    expect(computed).toBe(1)

    await cache().forget(k)
  })

  it('rememberForever keeps it without a ttl', async () => {
    const k = key('forever')

    expect(await cache().rememberForever(k, async () => 'kept')).toBe('kept')
    expect(await cache().get<string>(k)).toBe('kept')

    await cache().forget(k)
  })
})

describe('counters', () => {
  it('increment and decrement return the new value', async () => {
    const k = key('counter')

    expect(await cache().increment(k)).toBe(1)
    expect(await cache().increment(k, 5)).toBe(6)
    expect(await cache().decrement(k, 2)).toBe(4)

    await cache().forget(k)
  })
})

describe('locks', () => {
  /**
   * A lock nobody else can take is the entire contract.
   *
   * This is the primitive behind `withoutOverlapping` on a scheduled entry and on
   * a job, so it is worth one direct test rather than only being exercised
   * through them.
   */
  it('a held lock cannot be taken twice', async () => {
    const name = key('lock')
    const held = cache().lock(name, 10)

    expect(await held.get()).toBe(true)

    // A second lock on the same name, as a second process would build it.
    expect(await cache().lock(name, 10).get()).toBe(false)

    await held.release()

    // And released, it can be taken again — a lock that never frees is a
    // deadlock that only shows up under load.
    const after = cache().lock(name, 10)
    expect(await after.get()).toBe(true)
    await after.release()
  })
})
