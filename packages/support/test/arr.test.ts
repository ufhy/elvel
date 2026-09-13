import { describe, expect, test } from 'bun:test'
import { Arr, ArrTypeError } from '../src/arr.ts'

describe('Arr dot access', () => {
  const source = { app: { name: 'Elvel', nested: { debug: false } }, list: [1, 2] }

  test('get', () => {
    // Without a fallback the return type is `unknown`, so name the type here.
    expect(Arr.get<string>(source, 'app.name')).toBe('Elvel')
    expect(Arr.get<boolean>(source, 'app.nested.debug')).toBe(false)
    expect(Arr.get(source, 'app.missing', 'fallback')).toBe('fallback')
    expect(Arr.get(source, 'app.name.deeper', 'fallback')).toBe('fallback')
  })

  test('get returns the fallback for a key whose value is undefined', () => {
    expect(Arr.get({ path: undefined }, 'path', '/default')).toBe('/default')
  })

  test('set creates intermediate objects', () => {
    const target: Record<string, any> = {}
    Arr.set(target, 'view.cache.enabled', true)

    expect(target).toEqual({ view: { cache: { enabled: true } } })
  })

  test('has', () => {
    expect(Arr.has(source, 'app.nested.debug')).toBe(true)
    expect(Arr.has(source, 'app.nope')).toBe(false)
  })

  test('dot flattens', () => {
    expect(Arr.dot(source)).toEqual({
      'app.name': 'Elvel',
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
    // PHP cannot tell an array from a map, so it never had to choose. Here
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

  test('set and forget refuse a key that reaches the prototype chain', () => {
    const target: Record<string, any> = {}

    expect(() => Arr.set(target, '__proto__.isAdmin', true)).toThrow(/prototype chain/)
    expect(() => Arr.set(target, 'a.constructor.prototype.x', 1)).toThrow(/prototype chain/)
    expect(() => Arr.forget(target, '__proto__.toString')).toThrow(/prototype chain/)

    // The point of the guard: nothing leaked out onto every other object.
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
    expect({}.toString).toBeDefined()

    // And an ordinary nested write still works.
    expect(Arr.get<string>(Arr.set(target, 'user.name', 'Ada'), 'user.name')).toBe('Ada')
  })
})

describe('the additions', () => {
  test('add sets only what is missing', () => {
    expect(Arr.add({ name: 'kept' }, 'name', 'new')).toEqual({ name: 'kept' })
    expect(Arr.add({}, 'meta.page', 1)).toEqual({ meta: { page: 1 } })
  })

  /** Null counts as missing: a default is what a null column wants too. */
  test('and treats null as missing', () => {
    expect(Arr.add({ name: null }, 'name', 'new')).toEqual({ name: 'new' })
  })

  test('hasAll wants every path', () => {
    const target = { a: 1, b: { c: 2 } }

    expect(Arr.hasAll(target, ['a', 'b.c'])).toBe(true)
    expect(Arr.hasAll(target, ['a', 'b.d'])).toBe(false)
  })

  test('prependKeysWith namespaces a payload', () => {
    expect(Arr.prependKeysWith({ page: 1 }, 'meta.')).toEqual({ 'meta.page': 1 })
  })

  test('select projects the same keys out of every row', () => {
    const rows = [
      { id: 1, name: 'a', secret: 'x' },
      { id: 2, name: 'b', secret: 'y' }
    ]

    expect(Arr.select(rows, ['id', 'name'])).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' }
    ])
  })

  /** `filter(Boolean)` would drop the zero as well, which is the whole point. */
  test('whereNotNull keeps a falsy value that is not null', () => {
    expect(Arr.whereNotNull([0, null, '', undefined, false])).toEqual([0, '', false])
  })

  test('onlyValues and exceptValues', () => {
    const target = { a: 1, b: 2, c: 3 }

    expect(Arr.onlyValues(target, ['c', 'a'])).toEqual([3, 1])
    expect(Arr.exceptValues(target, ['b'])).toEqual([1, 3])
  })

  test('sortRecursive orders every level', () => {
    expect(Arr.sortRecursive({ b: ['z', 'a'], a: { d: 1, c: 2 } })).toEqual({
      a: { c: 2, d: 1 },
      b: ['a', 'z']
    })
  })

  /** A list of objects has no order to give it, so its order is left alone. */
  test('and leaves a list of objects in place', () => {
    expect(Arr.sortRecursive([{ b: 1 }, { a: 2 }])).toEqual([{ b: 1 }, { a: 2 }])
  })

  test('sortRecursiveDesc reverses it', () => {
    expect(Arr.sortRecursiveDesc({ a: 1, b: 2 })).toEqual({ b: 2, a: 1 })
  })
})

/**
 * A JSON body is `unknown` at runtime whatever the call site believes, so these
 * are the difference between a checked read and a cast that lies.
 */
describe('the typed readers', () => {
  const body = { page: '2', size: 10, ratio: '1.5', active: 'true', tags: ['a'], name: 'x' }

  test('read what is there', () => {
    expect(Arr.string(body, 'name')).toBe('x')
    expect(Arr.integer(body, 'size')).toBe(10)
    expect(Arr.float(body, 'ratio')).toBe(1.5)
    expect(Arr.boolean(body, 'active')).toBe(true)
    expect(Arr.array(body, 'tags')).toEqual(['a'])
  })

  /** A query parameter has no way to say it is a number. */
  test('a numeric string counts as a number', () => {
    expect(Arr.integer(body, 'page')).toBe(2)
  })

  test("and Boolean('false') is not how a boolean is read", () => {
    expect(Arr.boolean({ on: 'false' }, 'on')).toBe(false)
    expect(Arr.boolean({ on: 'no' }, 'on')).toBe(false)
    expect(Arr.boolean({ on: 'yes' }, 'on')).toBe(true)
  })

  test('a fallback answers for a missing key', () => {
    expect(Arr.string({}, 'name', 'default')).toBe('default')
    expect(Arr.integer({}, 'page', 1)).toBe(1)
  })

  test('and the wrong type names the key and what was there', () => {
    expect(() => Arr.integer({ page: 'first' }, 'page')).toThrow(ArrTypeError)
    expect(() => Arr.integer({ page: 1.5 }, 'page')).toThrow('[page] should be an integer')
    expect(() => Arr.string({ name: 4 }, 'name')).toThrow('it is number (4)')
    expect(() => Arr.array({}, 'tags')).toThrow('it is missing')
  })
})
