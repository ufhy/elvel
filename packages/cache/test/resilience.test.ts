import { describe, expect, test } from 'bun:test'
import { Limit } from '../src/limit.ts'
import { Repository } from '../src/repository.ts'
import type { Store } from '../src/store.ts'
import { ArrayStore } from '../src/stores/array.ts'
import { FailoverStore } from '../src/stores/failover.ts'
import { NullStore } from '../src/stores/null.ts'

/** A store that throws on everything, which is what a dead Redis looks like. */
function broken(): Store {
  const die = () => Promise.reject(new Error('redis is down'))

  return {
    prefix: '',
    get: die,
    many: die,
    put: die,
    putMany: die,
    add: die,
    increment: die,
    decrement: die,
    forever: die,
    forget: die,
    flush: die
  } as unknown as Store
}

describe('the null store', () => {
  test('every read misses and every write reports success', async () => {
    const cache = new Repository(new NullStore())

    expect(await cache.put('k', 1, 60)).toBe(true)
    expect(await cache.get('k')).toBeNull()
    expect(await cache.has('k')).toBe(false)
  })

  /** A store doing what it was configured to do has not failed. */
  test('a write does not look like a failure', async () => {
    const seen: string[] = []
    const cache = new Repository(new NullStore(), {
      events: { dispatch: (event: string) => seen.push(event) as unknown as undefined }
    })

    await cache.put('k', 1, 60)

    expect(seen).toContain('cache.written')
    expect(seen).not.toContain('cache.write-failed')
  })

  /** Two callers both told they won is how add-based locking stops locking. */
  test('but add reports failure, because nobody can win a race for nothing', async () => {
    expect(await new NullStore().add('k', 1, 60)).toBe(false)
  })

  test('remember computes every time', async () => {
    const cache = new Repository(new NullStore())
    let built = 0

    await cache.remember('k', 60, () => ++built)
    await cache.remember('k', 60, () => ++built)

    expect(built).toBe(2)
  })
})

describe('the failover store', () => {
  test('a read falls through to the next store', async () => {
    const fallback = new ArrayStore()
    await fallback.put('k', 'from the fallback', 60)

    const chain = new FailoverStore([broken(), fallback])

    expect(await chain.get<string>('k')).toBe('from the fallback')
  })

  test('and announces every fall-through', async () => {
    const fell: Array<[number, string]> = []
    const chain = new FailoverStore([broken(), new ArrayStore()], (index, operation) =>
      fell.push([index, operation])
    )

    await chain.get('k')

    expect(fell).toEqual([[0, 'get']])
  })

  /** Two copies with different lifetimes would have the fallback serving a stale one. */
  test('a write stops at the first store that takes it', async () => {
    const first = new ArrayStore()
    const second = new ArrayStore()
    const chain = new FailoverStore([first, second])

    await chain.put('k', 1, 60)

    expect(await first.get<number>('k')).toBe(1)
    expect(await second.get('k')).toBeNull()
  })

  /** A key written to both before the chain shifted would come back otherwise. */
  test('a forget reaches every store', async () => {
    const first = new ArrayStore()
    const second = new ArrayStore()

    await first.put('k', 1, 60)
    await second.put('k', 2, 60)

    await new FailoverStore([first, second]).forget('k')

    expect(await first.get('k')).toBeNull()
    expect(await second.get('k')).toBeNull()
  })

  test('the last error surfaces when nothing answered', async () => {
    const chain = new FailoverStore([broken(), broken()])

    await expect(chain.get('k')).rejects.toThrow('redis is down')
  })

  test('and a chain with nothing in it is refused', () => {
    expect(() => new FailoverStore([])).toThrow('at least one store')
  })
})

describe('locks after a crash', () => {
  const cache = () => new Repository(new ArrayStore())

  test('isLocked answers whether anybody holds it', async () => {
    const held = cache()
    const lock = held.lock('reports', 60)

    expect(await lock.isLocked()).toBe(false)

    await lock.acquire()

    expect(await lock.isLocked()).toBe(true)
  })

  /** The owner token is what makes an abandoned lock unreleasable. */
  test('forceRelease drops one nobody can release', async () => {
    const held = cache()

    await held.lock('reports', 60).acquire()

    // A different process: a new lock object, so a different owner token.
    const other = held.lock('reports', 60)

    expect(await other.release()).toBe(false)
    expect(await other.forceRelease()).toBe(true)
    expect(await other.isLocked()).toBe(false)
  })

  test('flushLocks drops all of them', async () => {
    const held = cache()

    await held.lock('one', 60).acquire()
    await held.lock('two', 60).acquire()

    expect(held.supportsFlushingLocks()).toBe(true)
    expect(await held.flushLocks()).toBe(true)
    expect(await held.lock('one', 60).isLocked()).toBe(false)
  })

  /** Redis keeps locks as ordinary keys, so flushing them would flush the cache. */
  test('and a store that cannot says so rather than pretending', async () => {
    const cannot = new Repository(new NullStore())

    expect(cannot.supportsFlushingLocks()).toBe(false)
    await expect(cannot.flushLocks()).rejects.toThrow('cannot flush locks')
  })
})

describe('rememberWithWarmth', () => {
  /** The other way to get this raced the read it was describing. */
  test('says whether the value was already there', async () => {
    const cache = new Repository(new ArrayStore())

    expect(await cache.rememberWithWarmth('k', 60, () => 'built')).toEqual(['built', false])
    expect(await cache.rememberWithWarmth('k', 60, () => 'again')).toEqual(['built', true])
  })
})

describe('a failed write', () => {
  /** It used to be a boolean almost nobody checks. */
  test('dispatches an event', async () => {
    const refusing = { ...new ArrayStore(), put: async () => false } as unknown as Store
    const seen: string[] = []

    const cache = new Repository(refusing, {
      events: { dispatch: (event: string) => seen.push(event) as unknown as undefined }
    })

    await cache.put('k', 1, 60)

    expect(seen).toContain('cache.write-failed')
  })
})

describe('a limit', () => {
  test('perMinutes reads as what it means', () => {
    expect(Limit.perMinutes(5, 100)).toMatchObject({ maxAttempts: 100, decaySeconds: 300 })
  })

  /** One visitor would otherwise exhaust the limit for every anonymous caller. */
  test('falls back to another key when it has none', () => {
    expect(Limit.perMinute(60).fallback('guests').keyOrFallback()).toBe('guests')
    expect(Limit.perMinute(60).by('user:1').fallback('guests').keyOrFallback()).toBe('user:1')
  })

  test('carries its own refusal and callback through by()', () => {
    const built = Limit.perMinute(60)
      .response(() => new Response('slow down', { status: 429 }))
      .after(() => undefined)
      .by('user:1')

    expect(built.key).toBe('user:1')
    expect(built.refusal).toBeDefined()
    expect(built.onExceeded).toBeDefined()
  })
})
