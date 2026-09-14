import { afterEach, describe, expect, test } from 'bun:test'
import { Collection } from '@elvel/support'
import { asEnum, castFromDatabase, castToDatabase, setAttributeHasher } from '../src/model/casts.ts'

afterEach(() => {
  setAttributeHasher(undefined)
})

/** A money column read as a float is a rounding bug waiting for a big enough number. */
describe('decimal', () => {
  test('reads as a string, so no digits are lost', () => {
    expect(castFromDatabase('12.5', 'decimal:2')).toBe('12.50')
    expect(castFromDatabase(0.1 + 0.2, 'decimal:2')).toBe('0.30')
  })

  test('writes with the places it was given', () => {
    expect(castToDatabase(12.5, 'decimal:4')).toBe('12.5000')
    expect(castToDatabase('3', 'decimal:0')).toBe('3')
  })
})

/** A Date is mutable, so the attribute and its original are the same object. */
describe('immutable dates', () => {
  test('are frozen', () => {
    const read = castFromDatabase('2026-08-11T09:30:00.000Z', 'immutable_datetime') as Date

    expect(read).toBeInstanceOf(Date)
    expect(Object.isFrozen(read)).toBe(true)
  })

  test('and write like their mutable twins', () => {
    const at = new Date('2026-08-11T09:30:00.000Z')

    expect(castToDatabase(at, 'immutable_date')).toBe('2026-08-11')
    expect(castToDatabase(at, 'immutable_datetime')).toBe('2026-08-11 09:30:00')
  })
})

describe('collection', () => {
  test('reads a JSON array as a Collection', () => {
    const read = castFromDatabase('[1,2,3]', 'collection') as Collection<number>

    expect(read).toBeInstanceOf(Collection)
    expect(read.sum()).toBe(6)
  })

  test('writes back as JSON', () => {
    expect(castToDatabase(new Collection([1, 2]), 'collection')).toBe('[1,2]')
  })

  test('and something that is not an array reads as empty rather than throwing', () => {
    expect((castFromDatabase('not json', 'collection') as Collection<unknown>).count()).toBe(0)
  })
})

describe('hashed', () => {
  test('hashes on the way in', () => {
    setAttributeHasher({ makeSync: (value) => `hashed(${value})`, isHashed: () => false })

    expect(castToDatabase('secret', 'hashed')).toBe('hashed(secret)')
  })

  /** A model saved twice would store the hash of its own hash. */
  test('and does not hash a hash again', () => {
    setAttributeHasher({ makeSync: (value) => `hashed(${value})`, isHashed: () => true })

    expect(castToDatabase('hashed(secret)', 'hashed')).toBe('hashed(secret)')
  })

  test('reads as stored, because a hash is one-way', () => {
    expect(castFromDatabase('hashed(secret)', 'hashed')).toBe('hashed(secret)')
  })

  test('and says what to register when nothing can hash', () => {
    expect(() => castToDatabase('secret', 'hashed')).toThrow('needs a hasher')
  })
})

/** A string cast gives the attribute no type, which is the thing worth checking. */
describe('asEnum', () => {
  const Status = { Pending: 'pending', Shipped: 'shipped' } as const

  test('passes a case through in both directions', () => {
    const cast = asEnum(Status)

    expect(cast.get({}, 'status', 'shipped', {})).toBe('shipped')
    expect(cast.set({}, 'status', 'pending', {})).toBe('pending')
  })

  /** A column outside the set is data the enum never knew about. */
  test('refuses a value that is not one of the cases', () => {
    const cast = asEnum(Status)

    expect(() => cast.get({}, 'status', 'exploded', {})).toThrow('not one of the cases')
    expect(() => cast.set({}, 'status', 'exploded' as never, {})).toThrow('not one of the cases')
  })

  test('null passes through untouched', () => {
    const cast = asEnum(Status)

    expect(cast.get({}, 'status', null, {})).toBeUndefined()
    expect(cast.set({}, 'status', null as never, {})).toBeNull()
  })

  test('and a list of values works as well as an object', () => {
    const cast = asEnum(['a', 'b'] as const)

    expect(cast.get({}, 'kind', 'b', {})).toBe('b')
  })
})
