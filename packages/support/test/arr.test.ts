import { describe, expect, test } from 'bun:test'
import { Arr } from '../src/arr.ts'

describe('Arr dot access', () => {
  const source = { app: { name: 'Elyvel', nested: { debug: false } }, list: [1, 2] }

  test('get', () => {
    // Without a fallback the return type is `unknown`, so name the type here.
    expect(Arr.get<string>(source, 'app.name')).toBe('Elyvel')
    expect(Arr.get<boolean>(source, 'app.nested.debug')).toBe(false)
    expect(Arr.get(source, 'app.missing', 'fallback')).toBe('fallback')
    expect(Arr.get(source, 'app.name.deeper', 'fallback')).toBe('fallback')
  })

  test('get returns the fallback for a key whose value is undefined', () => {
    expect(Arr.get({ path: undefined }, 'path', '/default')).toBe('/default')
  })

  test('set creates intermediate objects', () => {
    const target: Record<string, unknown> = {}
    Arr.set(target, 'view.cache.enabled', true)

    expect(target).toEqual({ view: { cache: { enabled: true } } })
  })

  test('has', () => {
    expect(Arr.has(source, 'app.nested.debug')).toBe(true)
    expect(Arr.has(source, 'app.nope')).toBe(false)
  })

  test('dot flattens', () => {
    expect(Arr.dot(source)).toEqual({
      'app.name': 'Elyvel',
      'app.nested.debug': false,
      list: [1, 2]
    })
  })
})

describe('Arr mutation helpers', () => {
  test('wrap normalises to an array', () => {
    expect(Arr.wrap('a')).toEqual(['a'])
    expect(Arr.wrap(['a'])).toEqual(['a'])
    expect(Arr.wrap(null)).toEqual([])
    expect(Arr.wrap(undefined)).toEqual([])
    // Falsy but present values are kept
    expect(Arr.wrap(0)).toEqual([0])
    expect(Arr.wrap(false)).toEqual([false])
  })

  test('forget removes a nested key and leaves siblings', () => {
    const target: Record<string, unknown> = { app: { name: 'x', debug: true } }
    Arr.forget(target, 'app.debug')

    expect(target).toEqual({ app: { name: 'x' } })
  })

  test('forget on a missing path is a no-op', () => {
    const target: Record<string, unknown> = { app: { name: 'x' } }
    Arr.forget(target, 'nope.deeper')

    expect(target).toEqual({ app: { name: 'x' } })
  })

  test('only and except are complements and do not mutate', () => {
    const source = { a: 1, b: 2, c: 3 }

    expect(Arr.only(source, ['a', 'c'])).toEqual({ a: 1, c: 3 })
    expect(Arr.except(source, ['a', 'c'])).toEqual({ b: 2 })
    expect(source).toEqual({ a: 1, b: 2, c: 3 })
  })

  test('only skips keys that are absent', () => {
    const source: Record<string, number> = { a: 1 }

    expect(Arr.only(source, ['a', 'missing']) as Record<string, number>).toEqual({ a: 1 })
  })

  test('dot keeps arrays and dates whole, and empty objects as leaves', () => {
    const date = new Date(0)
    const flat = Arr.dot({ list: [1, 2], when: date, empty: {}, deep: { a: 1 } })

    expect(flat).toEqual({ list: [1, 2], when: date, empty: {}, 'deep.a': 1 })
  })

  test('flatten respects depth', () => {
    expect(Arr.flatten([1, [2, [3]]])).toEqual([1, 2, 3])
    expect(Arr.flatten([1, [2, [3]]], 1)).toEqual([1, 2, [3]])
  })

  test('unique, first, last', () => {
    expect(Arr.unique([1, 1, 2])).toEqual([1, 2])
    expect(Arr.first([1, 2])).toBe(1)
    expect(Arr.first([1, 2], (value) => value > 1)).toBe(2)
    expect(Arr.first([], (value) => value === 1)).toBeUndefined()
    expect(Arr.last([1, 2])).toBe(2)
    expect(Arr.last([])).toBeUndefined()
  })

  test('groupBy and sortBy', () => {
    expect(Arr.groupBy(['apple', 'avocado', 'beet'], (word) => word[0] as string)).toEqual({
      a: ['apple', 'avocado'],
      b: ['beet']
    })

    const source = [3, 1, 2]
    expect(Arr.sortBy(source, (value) => value)).toEqual([1, 2, 3])
    expect(source).toEqual([3, 1, 2])
  })
})

describe('Arr.set with numeric segments', () => {
  test('a numeric key creates an array', () => {
    // PHP cannot tell an array from a map, so Laravel never had to choose. Here
    // the choice is visible the moment the result is serialised.
    expect(Arr.set({}, 'items.0.price', 10)).toEqual({ items: [{ price: 10 }] })
    expect(Array.isArray(Arr.set({}, 'items.0.price', 10).items)).toBe(true)
  })

  test('a non-numeric key still creates an object', () => {
    expect(Arr.set({}, 'user.name', 'Ada')).toEqual({ user: { name: 'Ada' } })
  })

  test('a sparse write leaves holes rather than renumbering', () => {
    const result = Arr.set({}, 'items.2.price', 3) as { items: unknown[] }

    // The index the caller asked for is the index it lands on: shifting it to 0
    // would silently rename `items.2` to `items.0`.
    expect(result.items).toHaveLength(3)
    expect(result.items[2]).toEqual({ price: 3 })
  })

  test('an existing container is not replaced', () => {
    const target: { items: Array<Record<string, number>> } = { items: [{ price: 1 }] }

    Arr.set(target, 'items.0.tax', 2)

    expect(target.items[0]).toEqual({ price: 1, tax: 2 })
  })
})
