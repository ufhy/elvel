import { describe, expect, test } from 'bun:test'
import {
  enterRequestContext,
  inRequestContext,
  requestSlot,
  withoutRequestContext
} from '../src/request-context.ts'

/**
 * One context, five slots, and nothing crossing between requests.
 *
 * The context is now a single object that later writers **mutate** rather than
 * re-enter, which is what makes it cheap — and which is exactly why the leak
 * test below matters more than the rest. If two requests in flight shared one
 * object, one visitor's session would be readable by another, and that is a
 * different class of bug from a slow route.
 */

describe('a slot', () => {
  test('reads as absent outside a request', () => {
    const slot = requestSlot<string>('absent')

    withoutRequestContext(() => {
      expect(slot.get()).toBeUndefined()
    })
  })

  test('can be set where no context exists yet, and enters one', () => {
    const slot = requestSlot<string>('first')

    withoutRequestContext(() => {
      expect(inRequestContext()).toBe(true) // withoutRequestContext enters an empty one
    })

    // In a context of its own, with nothing entered before it.
    const seen = withoutRequestContext(() => {
      slot.set('written')
      return slot.get()
    })

    expect(seen).toBe('written')
  })

  test('does not disturb another slot', () => {
    const one = requestSlot<string>('one')
    const two = requestSlot<number>('two')

    withoutRequestContext(() => {
      one.set('a')
      two.set(2)

      expect(one.get()).toBe('a')
      expect(two.get()).toBe(2)
    })
  })

  /**
   * Two slots of the same name are two slots.
   *
   * The identity is the symbol, so two packages that both call theirs `session`
   * get their own rather than one they overwrite for each other.
   */
  test('is identified by its symbol, not its name', () => {
    const mine = requestSlot<string>('session')
    const theirs = requestSlot<string>('session')

    withoutRequestContext(() => {
      mine.set('mine')

      expect(theirs.get()).toBeUndefined()
    })
  })
})

describe('run', () => {
  test('leaves the surrounding context in place', () => {
    const outer = requestSlot<string>('outer')
    const inner = requestSlot<string>('inner')

    withoutRequestContext(() => {
      outer.set('kept')

      inner.run('scoped', () => {
        expect(inner.get()).toBe('scoped')
        // The whole reason `run` merges: with five storages this was isolated
        // because it could not see the others.
        expect(outer.get()).toBe('kept')
      })

      expect(inner.get()).toBeUndefined()
    })
  })

  test('restores the previous value afterwards', () => {
    const slot = requestSlot<string>('restored')

    withoutRequestContext(() => {
      slot.set('before')

      slot.run('during', () => {
        expect(slot.get()).toBe('during')
      })

      expect(slot.get()).toBe('before')
    })
  })
})

/**
 * The test this file exists for.
 *
 * Both "requests" set every slot, then interleave awaits so their continuations
 * are scheduled against each other, then read everything back. Anything crossing
 * over is a session leak.
 */
test('two requests in flight never see each other', async () => {
  const session = requestSlot<string>('session')
  const route = requestSlot<string>('route')
  const cookies = requestSlot<string>('cookies')

  const request = async (name: string, pauses: number): Promise<string[]> =>
    withoutRequestContext(async () => {
      session.set(`${name}-session`)
      route.set(`${name}-route`)
      cookies.set(`${name}-cookies`)

      for (let i = 0; i < pauses; i++) await Bun.sleep(0)

      // Written after the awaits too: mutation has to stay on this request.
      session.set(`${name}-session-again`)
      await Bun.sleep(0)

      return [session.get() ?? '?', route.get() ?? '?', cookies.get() ?? '?']
    })

  const [a, b, c] = await Promise.all([request('a', 3), request('b', 1), request('c', 5)])

  expect(a).toEqual(['a-session-again', 'a-route', 'a-cookies'])
  expect(b).toEqual(['b-session-again', 'b-route', 'b-cookies'])
  expect(c).toEqual(['c-session-again', 'c-route', 'c-cookies'])
})

/**
 * Many at once, because three can pass by luck.
 */
test('a hundred at once each keep their own', async () => {
  const slot = requestSlot<number>('many')

  const one = async (n: number): Promise<number | undefined> =>
    withoutRequestContext(async () => {
      slot.set(n)
      await Bun.sleep(n % 5)
      return slot.get()
    })

  const answers = await Promise.all(Array.from({ length: 100 }, (_, n) => one(n)))

  expect(answers).toEqual(Array.from({ length: 100 }, (_, n) => n))
})

/**
 * What opens the context, and what that buys.
 *
 * `enterRequestContext` is what the http layer calls from its first synchronous
 * hook. These two tests are the contract it exists for — and the second one is
 * deliberately *not* a concurrency claim, because `set` alone cannot make one:
 * called synchronously from a frame shared with another request it would mutate
 * that request's context, which is exactly why the explicit opening exists.
 */
describe('enterRequestContext', () => {
  test('isolates executions that each open their own', async () => {
    const session = requestSlot<string>('opened-session')
    const cookies = requestSlot<string>('opened-cookies')

    const request = async (name: string, pauses: number): Promise<string[]> => {
      enterRequestContext()
      session.set(`${name}-session`)
      cookies.set(`${name}-cookies`)

      for (let i = 0; i < pauses; i++) await Bun.sleep(0)

      session.set(`${name}-again`)
      await Bun.sleep(0)

      return [session.get() ?? '?', cookies.get() ?? '?']
    }

    const [a, b, c] = await Promise.all([request('a', 4), request('b', 1), request('c', 2)])

    expect(a).toEqual(['a-again', 'a-cookies'])
    expect(b).toEqual(['b-again', 'b-cookies'])
    expect(c).toEqual(['c-again', 'c-cookies'])
  })

  /**
   * Inherits, and that is deliberate.
   *
   * `AuthManager.runWith` — how a test acts as a signed-in user — sets the
   * session and then calls the application, so the hook that opens the context
   * runs *inside* it. Opening an empty one threw the session away and every
   * guarded route in the suite answered as a guest.
   */
  test('carries in what something outside established', () => {
    const slot = requestSlot<string>('acting-as')

    withoutRequestContext(() => {
      slot.set('a signed-in user')

      enterRequestContext()

      expect(slot.get()).toBe('a signed-in user')
    })
  })

  /**
   * And still a fresh object, which is the other half.
   *
   * What the request writes must not escape into whatever surrounds it, or one
   * request's session outlives it.
   */
  test('does not let what the request writes escape outwards', () => {
    const slot = requestSlot<string>('escaping')

    withoutRequestContext(() => {
      slot.set('outer')

      const inner = () => {
        enterRequestContext()
        slot.set('written by the request')
        return slot.get()
      }

      expect(withoutRequestContext(() => inner())).toBe('written by the request')

      // The surrounding context is untouched.
      expect(slot.get()).toBe('outer')
    })
  })
})

/**
 * The fallback, for everything that is not a request.
 *
 * A console command or a queue worker has no hook to open a context, so the
 * first slot written opens one. Asserted on its own rather than concurrently:
 * see the note above.
 */
test('a slot written with no context at all opens one', async () => {
  const slot = requestSlot<string>('fallback')

  // Its own async execution, the way a worker's job is.
  const answer = await (async () => {
    slot.set('written')
    await Bun.sleep(0)
    return slot.get()
  })()

  expect(answer).toBe('written')
})
