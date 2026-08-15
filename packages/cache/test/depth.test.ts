import { beforeEach, describe, expect, test } from 'bun:test'
import { ArrayStore, Repository } from '../src/index.ts'

let cache: Repository

beforeEach(() => {
  cache = new Repository(new ArrayStore())
})

describe('several keys at once', () => {
  test('deleteMultiple forgets them all', async () => {
    await cache.putMany({ a: 1, b: 2, c: 3 })

    expect(await cache.deleteMultiple(['a', 'b'])).toBe(true)
    expect(await cache.get('a')).toBeNull()
    expect<unknown>(await cache.get('c')).toBe(3)
  })

  /**
   * It keeps going after a miss.
   *
   * Stopping at the first key that was not there leaves the rest of them cached,
   * which is the failure this is usually called to prevent.
   */
  test('and still clears the rest when one was not there', async () => {
    await cache.putMany({ a: 1, b: 2 })

    await cache.deleteMultiple(['a', 'nowhere', 'b'])

    expect(await cache.get('a')).toBeNull()
    expect(await cache.get('b')).toBeNull()
  })

  test('the PSR-16 spellings reach the same code', async () => {
    await cache.setMultiple({ x: 1, y: 2 })

    expect(await cache.getMultiple(['x', 'y'])).toEqual({ x: 1, y: 2 })
  })
})

describe('touch', () => {
  test('extends a key without changing what it holds', async () => {
    await cache.put('session', { id: 7 }, 1)

    expect(await cache.touch('session', 60)).toBe(true)
    expect<unknown>(await cache.get('session')).toEqual({ id: 7 })

    // The old one-second window has gone; the value is still there after it.
    await Bun.sleep(1100)
    expect<unknown>(await cache.get('session')).toEqual({ id: 7 })
  })

  test('a key that is not there cannot be extended', async () => {
    expect(await cache.touch('nowhere')).toBe(false)
  })
})

describe('supportsTags', () => {
  test('reports what the store can do', () => {
    // The array store keeps its own tag bookkeeping, so tagging works.
    expect(cache.supportsTags()).toBe(true)
  })
})
