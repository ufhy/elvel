import { describe, expect, test } from 'bun:test'
import { RateLimiter } from '../src/rate-limiter.ts'
import { Repository } from '../src/repository.ts'
import type { Store } from '../src/store.ts'
import { ArrayStore } from '../src/stores/array.ts'

/**
 * The rate limiter, and the round trips it used to spend.
 *
 * Recording one attempt was three cache calls — add the timer, add the counter to
 * give it a window, increment it, and put it back if the window had gone — and the
 * response hook then read the counter again to write `X-RateLimit-Remaining`. Five
 * calls per throttled request, 121µs against Redis. It is two now, and 65µs.
 *
 * `Store.incrementWithin` is what made that possible: increment, and set the
 * window only if the key was created. The properties it must not break are the
 * ones a rate limit *is* — a fixed window, and a refusal at the right count.
 */
class CountingStore extends ArrayStore {
  calls = 0

  override async get<T>(key: string): Promise<T | null> {
    this.calls += 1

    return super.get<T>(key)
  }

  override async put(key: string, value: unknown, seconds: number): Promise<boolean> {
    this.calls += 1

    return super.put(key, value, seconds)
  }

  override async add(key: string, value: unknown, seconds: number): Promise<boolean> {
    this.calls += 1

    return super.add(key, value, seconds)
  }

  override async increment(key: string, value?: number): Promise<number | false> {
    this.calls += 1

    return super.increment(key, value)
  }

  override async incrementWithin(key: string, seconds: number, value?: number): Promise<number> {
    this.calls += 1

    return super.incrementWithin(key, seconds, value)
  }
}

/** The same store with the one-step primitive hidden, as a file or DB store is. */
class PlainStore extends CountingStore {
  override incrementWithin = undefined as never
}

describe('recording an attempt', () => {
  test('is one call once the window is open', async () => {
    const store = new CountingStore()
    const limiter = new RateLimiter(new Repository(store))

    await limiter.hit('k', 60)

    store.calls = 0
    await limiter.hit('k', 60)

    expect<number>(store.calls).toBe(1)
  })

  /**
   * The first hit also writes the timer `availableIn` reads, so it is two — the
   * increment and the timer. Counted at the repository rather than the store,
   * because `ArrayStore.incrementWithin` reaches its own `put` to create the key
   * and that is not a round trip anywhere it matters.
   */
  test('and two when it opens it', async () => {
    let calls = 0

    const repository = new Repository(new ArrayStore())
    const counted = new Proxy(repository, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown

        if (typeof value !== 'function') return value

        return (...args: unknown[]) => {
          calls += 1

          return (value as (...rest: unknown[]) => unknown).apply(target, args)
        }
      }
    })

    await new RateLimiter(counted).hit('fresh', 60)

    expect<number>(calls).toBe(2)
  })

  test('while a store without the primitive keeps the old sequence', async () => {
    const store = new PlainStore()
    const limiter = new RateLimiter(new Repository(store))

    expect<number>(await limiter.hit('k', 60)).toBe(1)
    expect<number>(await limiter.hit('k', 60)).toBe(2)
    expect<number>(await limiter.attempts('k')).toBe(2)
  })
})

describe('the window is fixed, not sliding', () => {
  /**
   * A client that keeps knocking must still be let back in when the window it
   * opened runs out. Setting the expiry on every hit — the obvious way to write
   * this — would push the reset out forever and lock the client out permanently.
   */
  test('so knocking through it never rewrites the counter or the timer', async () => {
    const written: string[] = []

    class Watching extends ArrayStore {
      override async put(key: string, value: unknown, seconds: number): Promise<boolean> {
        written.push(key)

        return super.put(key, value, seconds)
      }
    }

    const limiter = new RateLimiter(new Repository(new Watching()))

    await limiter.hit('w', 60)

    // The opening hit creates the counter and the timer; nothing after it writes.
    written.length = 0

    for (let attempt = 0; attempt < 50; attempt++) await limiter.hit('w', 60)

    expect<string[]>(written).toEqual([])
    expect<number>(await limiter.attempts('w')).toBe(51)
  })

  /**
   * And the window does run out. Two seconds rather than one, waited past rather
   * than up to: expiry here is whole seconds, so a one-second window can end
   * anywhere between one and two seconds of real time and a test that sleeps 1.2s
   * is asserting on a coin toss. Found by writing it that way first.
   */
  test('and it does end', async () => {
    const limiter = new RateLimiter(new Repository(new ArrayStore()))

    for (let attempt = 0; attempt < 3; attempt++) await limiter.hit('w', 2)

    expect<boolean>(await limiter.tooManyAttempts('w', 3)).toBe(true)

    await Bun.sleep(2400)

    expect<boolean>(await limiter.tooManyAttempts('w', 3)).toBe(false)
    expect<number>(await limiter.attempts('w')).toBe(0)
  })

  test('and the timer still says when to come back', async () => {
    const limiter = new RateLimiter(new Repository(new ArrayStore()))

    await limiter.hit('r', 60)

    const seconds = await limiter.availableIn('r')

    expect<boolean>(seconds > 0 && seconds <= 60).toBe(true)
  })
})

describe('the limit itself', () => {
  test('refuses at the attempt after the last allowed one', async () => {
    const limiter = new RateLimiter(new Repository(new ArrayStore()))
    const allowed: boolean[] = []

    for (let attempt = 0; attempt < 4; attempt++) {
      const blocked = await limiter.tooManyAttempts('l', 3)

      allowed.push(!blocked)

      if (!blocked) await limiter.hit('l', 60)
    }

    expect<boolean[]>(allowed).toEqual([true, true, true, false])
  })

  /** A refused attempt does not count, which is Laravel's behaviour. */
  test('and a refusal does not raise the count', async () => {
    const limiter = new RateLimiter(new Repository(new ArrayStore()))

    for (let attempt = 0; attempt < 3; attempt++) await limiter.hit('l', 60)

    expect<boolean>(await limiter.tooManyAttempts('l', 3)).toBe(true)
    expect<number>(await limiter.attempts('l')).toBe(3)
  })
})

describe('incrementWithin', () => {
  const store = (): Store => new ArrayStore()

  test('creates the key with the window', async () => {
    const cache = store()

    expect<number>(await cache.incrementWithin?.('n', 60)).toBe(1)
    expect<unknown>(await cache.get('n')).toBe(1)
  })

  /**
   * Asserted by what it does not do, rather than by waiting: expiry here is whole
   * seconds, so a test that sleeps across a one-second window is deciding on a
   * boundary rather than on behaviour. What matters is that the second call does
   * not write the key again — writing it is what would move the window.
   */
  test('and adds to one that exists without writing it again', async () => {
    let writes = 0

    class Watching extends ArrayStore {
      override async put(key: string, value: unknown, seconds: number): Promise<boolean> {
        writes += 1

        return super.put(key, value, seconds)
      }
    }

    const cache = new Watching()

    expect<number>(await cache.incrementWithin('n', 60)).toBe(1)

    const opening = writes

    expect<number>(await cache.incrementWithin('n', 60)).toBe(2)
    expect<number>(writes).toBe(opening)
  })

  test('and counts by the amount it was given', async () => {
    const cache = store()

    expect<number>(await cache.incrementWithin?.('n', 60, 5)).toBe(5)
    expect<number>(await cache.incrementWithin?.('n', 60, 3)).toBe(8)
  })

  /** A key holding something that is not a number starts over rather than failing. */
  test('and replaces a value it cannot add to', async () => {
    const cache = store()

    await cache.put('n', 'not a number', 60)

    expect<number>(await cache.incrementWithin?.('n', 60)).toBe(1)
  })
})
