import { describe, expect, test } from 'bun:test'
import { collect } from '../src/collection.ts'
import { KeyedCollection, keyed } from '../src/keyed.ts'

const people = [
  { name: 'Ada', role: 'admin', age: 36 },
  { name: 'Grace', role: 'admin', age: 45 },
  { name: 'Linus', role: 'user', age: 28 }
]

/** The whole reason the type exists: the chain used to end here. */
describe('the chain survives a key', () => {
  test('keyBy answers with something that can still be mapped', () => {
    const byName = collect(people)
      .keyBy((one) => one.name)
      .map((one) => one.age)
      .filter((age) => age > 30)

    expect(byName.toObject()).toEqual({ Ada: 36, Grace: 45 })
  })

  test('groupBy hands back collections, not arrays', () => {
    const byRole = collect(people).groupBy((one) => one.role)

    expect(byRole.get('admin')?.pluck('name').all()).toEqual(['Ada', 'Grace'])
    expect(byRole.map((group) => group.count()).toObject()).toEqual({ admin: 2, user: 1 })
  })

  test('countBy too', () => {
    expect(
      collect(people)
        .countBy((one) => one.role)
        .toObject()
    ).toEqual({ admin: 2, user: 1 })
  })

  test('mapToGroups decides key and value at once', () => {
    const groups = collect(people).mapToGroups((one) => [one.role, one.name])

    expect(groups.get('admin')?.all()).toEqual(['Ada', 'Grace'])
  })

  test('mapToDictionary keeps them as arrays', () => {
    expect(
      collect(people)
        .mapToDictionary((one) => [one.role, one.name])
        .toObject()
    ).toEqual({ admin: ['Ada', 'Grace'], user: ['Linus'] })
  })

  test('and values() goes back to a list', () => {
    expect(
      collect(people)
        .keyBy((one) => one.name)
        .values()
        .count()
    ).toBe(3)
  })
})

/** An object stringifies every key and promises no order; a Map does neither. */
describe('a Map underneath', () => {
  test('a numeric key stays a number', () => {
    const byId = collect([{ id: 1 }, { id: 2 }]).keyBy((row) => row.id)

    expect(byId.keys().all()).toEqual([1, 2])
    expect(byId.get(1)).toEqual({ id: 1 })
  })

  test('and insertion order is the order', () => {
    expect(keyed({ b: 1, a: 2 }).keys().all()).toEqual(['b', 'a'])
  })
})

describe('reading', () => {
  const items = keyed({ a: 1, b: 2 })

  test('get, with and without a fallback', () => {
    expect(items.get('a')).toBe(1)
    expect(items.get('z')).toBeUndefined()
    expect(items.get('z', 9)).toBe(9)
  })

  test('has, hasAny and hasAll', () => {
    expect(items.has('a')).toBe(true)
    expect(items.hasAny(['z', 'b'])).toBe(true)
    expect(items.hasAll(['a', 'z'])).toBe(false)
  })

  test('keys, values, entries and count', () => {
    expect(items.keys().all()).toEqual(['a', 'b'])
    expect(items.values().all()).toEqual([1, 2])
    expect(items.entries().all()).toEqual([
      ['a', 1],
      ['b', 2]
    ])
    expect(items.count()).toBe(2)
  })
})

describe('mutating', () => {
  test('put and getOrPut', () => {
    const items = keyed<number>({})

    items.put('a', 1)

    expect(items.getOrPut('a', () => 99)).toBe(1)
    expect(items.getOrPut('b', () => 2)).toBe(2)
    expect(items.toObject()).toEqual({ a: 1, b: 2 })
  })

  test('forget and pull', () => {
    const items = keyed({ a: 1, b: 2 })

    expect(items.pull('a')).toBe(1)
    expect(items.forget('b').isEmpty()).toBe(true)
  })
})

describe('combining', () => {
  test('union keeps what is already here', () => {
    expect(keyed({ a: 1 }).union({ a: 9, b: 2 }).toObject()).toEqual({ a: 1, b: 2 })
  })

  test('merge lets the other one win', () => {
    expect(keyed({ a: 1 }).merge({ a: 9, b: 2 }).toObject()).toEqual({ a: 9, b: 2 })
  })

  test('replaceRecursive goes one level down', () => {
    const settings = keyed<Record<string, unknown>>({ mail: { host: 'a', port: 25 } })

    expect(settings.replaceRecursive({ mail: { host: 'b' } }).toObject()).toEqual({
      mail: { host: 'b', port: 25 }
    })
  })

  test('mergeRecursive appends a list rather than replacing it', () => {
    const settings = keyed<unknown>({ hosts: ['a'] })

    expect(settings.mergeRecursive({ hosts: ['b'] }).toObject()).toEqual({ hosts: ['a', 'b'] })
  })

  test('combine zips a list of keys with a list of values', () => {
    expect(KeyedCollection.combine(['a', 'b'], [1, 2]).toObject()).toEqual({ a: 1, b: 2 })
  })

  test('flip swaps them', () => {
    expect(keyed({ a: 'x' }).flip().toObject()).toEqual({ x: 'a' })
  })
})

describe('comparing', () => {
  const items = keyed({ a: 1, b: 2, c: 3 })

  test('diffKeys and intersectByKeys look at keys alone', () => {
    expect(items.diffKeys({ a: 9 }).keys().all()).toEqual(['b', 'c'])
    expect(items.intersectByKeys({ a: 9, c: 9 }).keys().all()).toEqual(['a', 'c'])
  })

  test('diffAssoc and intersectAssoc look at both', () => {
    expect(items.diffAssoc({ a: 1, b: 9 }).toObject()).toEqual({ b: 2, c: 3 })
    expect(items.intersectAssoc({ a: 1, b: 9 }).toObject()).toEqual({ a: 1 })
  })
})

describe('ordering', () => {
  test('sortKeys and sortKeysDesc', () => {
    const items = keyed({ b: 1, a: 2, c: 3 })

    expect(items.sortKeys().keys().all()).toEqual(['a', 'b', 'c'])
    expect(items.sortKeysDesc().keys().all()).toEqual(['c', 'b', 'a'])
  })

  test('sortKeysUsing takes the comparison', () => {
    const items = keyed({ bb: 1, a: 2, ccc: 3 })

    expect(
      items
        .sortKeysUsing((left, right) => left.length - right.length)
        .keys()
        .all()
    ).toEqual(['a', 'bb', 'ccc'])
  })
})

describe('walking', () => {
  test('map keeps the keys and mapWithKeys rewrites both', () => {
    expect(
      keyed({ a: 1 })
        .map((value) => value * 2)
        .toObject()
    ).toEqual({ a: 2 })
    expect(
      keyed({ a: 1 })
        .mapWithKeys((value, key) => [`${key}!`, value])
        .toObject()
    ).toEqual({
      'a!': 1
    })
  })

  test('mapKeys touches only the keys', () => {
    expect(
      keyed({ a: 1 })
        .mapKeys((key) => key.toUpperCase())
        .toObject()
    ).toEqual({ A: 1 })
  })

  test('filter, reject and except see the key', () => {
    const items = keyed({ a: 1, b: 2, c: 3 })

    expect(
      items
        .filter((_value, key) => key !== 'b')
        .keys()
        .all()
    ).toEqual(['a', 'c'])
    expect(
      items
        .reject((value) => value > 2)
        .keys()
        .all()
    ).toEqual(['a', 'b'])
    expect(items.except(['a']).keys().all()).toEqual(['b', 'c'])
    expect(items.only(['c', 'a']).keys().all()).toEqual(['c', 'a'])
  })

  test('each stops on false', () => {
    const seen: string[] = []

    keyed({ a: 1, b: 2 }).each((_value, key) => {
      seen.push(key)

      return false
    })

    expect(seen).toEqual(['a'])
  })

  /** What a list cannot offer, which is why the reduce is here and not there. */
  test('reduceWithKeys has the key in hand', () => {
    const answer = keyed({ a: 1, b: 2 }).reduceWithKeys(
      (carry, value, key) => `${carry}${key}${value}`,
      ''
    )

    expect(answer).toBe('a1b2')
  })
})

describe('dot and undot', () => {
  test('flatten to what a form speaks', () => {
    expect(
      keyed<unknown>({ mail: { host: 'a', port: 25 }, debug: true })
        .dot()
        .toObject()
    ).toEqual({
      'mail.host': 'a',
      'mail.port': 25,
      debug: true
    })
  })

  test('and back again', () => {
    expect(keyed<unknown>({ 'mail.host': 'a', 'mail.port': 25 }).undot().toObject()).toEqual({
      mail: { host: 'a', port: 25 }
    })
  })

  test('prependKeysWith namespaces them', () => {
    expect(keyed({ page: 1 }).prependKeysWith('meta.').toObject()).toEqual({ 'meta.page': 1 })
  })
})

describe('leaving', () => {
  test('toObject, toMap and toJSON', () => {
    const items = keyed({ a: 1 })

    expect(items.toObject()).toEqual({ a: 1 })
    expect(items.toMap()).toEqual(new Map([['a', 1]]))
    expect(JSON.stringify(items)).toBe('{"a":1}')
  })
})
