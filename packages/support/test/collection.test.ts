import { describe, expect, test } from 'bun:test'
import { Collection, collect } from '../src/collection.ts'

describe('construction', () => {
  test('collect copies the source', () => {
    const source = [1, 2, 3]
    const collection = collect(source)
    source.push(4)

    expect(collection.count()).toBe(3)
  })

  test('all returns a copy, not the backing array', () => {
    const collection = collect([1, 2])
    collection.all().push(3)

    expect(collection.count()).toBe(2)
  })

  test('accepts any iterable', () => {
    expect(collect(new Set([1, 1, 2])).all()).toEqual([1, 2])
    expect(collect('ab').all()).toEqual(['a', 'b'])
    expect(collect().all()).toEqual([])
  })

  test('is iterable and spreadable', () => {
    expect([...collect([1, 2])]).toEqual([1, 2])
  })

  test('serialises as a plain array', () => {
    expect(JSON.stringify({ items: collect([1, 2]) })).toBe('{"items":[1,2]}')
  })
})

describe('counting', () => {
  test('length, count and emptiness agree', () => {
    const empty = collect<number>([])
    const full = collect([1])

    expect(empty.length).toBe(0)
    expect(empty.count()).toBe(0)
    expect(empty.isEmpty()).toBe(true)
    expect(empty.isNotEmpty()).toBe(false)

    expect(full.isEmpty()).toBe(false)
    expect(full.isNotEmpty()).toBe(true)
  })
})

describe('transformation', () => {
  test('map and flatMap return new collections', () => {
    const original = collect([1, 2])
    const mapped = original.map((value) => value * 2)

    expect(mapped).toBeInstanceOf(Collection)
    expect(mapped.all()).toEqual([2, 4])
    expect(original.all()).toEqual([1, 2])
    expect(
      collect([1, 2])
        .flatMap((value) => [value, value])
        .all()
    ).toEqual([1, 1, 2, 2])
  })

  test('map receives the index', () => {
    expect(
      collect(['a', 'b'])
        .map((value, index) => `${index}${value}`)
        .all()
    ).toEqual(['0a', '1b'])
  })

  test('filter and reject are complements', () => {
    const numbers = collect([1, 2, 3, 4])
    const even = (value: number) => value % 2 === 0

    expect(numbers.filter(even).all()).toEqual([2, 4])
    expect(numbers.reject(even).all()).toEqual([1, 3])
  })

  test('each visits every item and stays chainable', () => {
    const seen: number[] = []
    const collection = collect([1, 2])

    expect(collection.each((value) => seen.push(value))).toBe(collection)
    expect(seen).toEqual([1, 2])
  })

  test('reduce folds with an initial value', () => {
    expect(collect([1, 2, 3]).reduce((carry, value) => carry + value, 0)).toBe(6)
    expect(collect<number>([]).reduce((carry, value) => carry + value, 10)).toBe(10)
  })

  test('pluck extracts a key', () => {
    const rows = collect([{ id: 1 }, { id: 2 }])

    expect(rows.pluck('id').all()).toEqual([1, 2])
  })

  test('unique removes duplicates', () => {
    expect(collect([1, 1, 2, 2, 3]).unique().all()).toEqual([1, 2, 3])
  })

  test('take slices from the front, and from the back when negative', () => {
    const numbers = collect([1, 2, 3, 4])

    expect(numbers.take(2).all()).toEqual([1, 2])
    expect(numbers.take(-2).all()).toEqual([3, 4])
    expect(numbers.take(0).all()).toEqual([])
    expect(numbers.take(99).all()).toEqual([1, 2, 3, 4])
  })
})

describe('inspection', () => {
  test('first returns the head, or the first match', () => {
    const numbers = collect([1, 2, 3])

    expect(numbers.first()).toBe(1)
    expect(numbers.first((value) => value > 1)).toBe(2)
    expect(numbers.first((value) => value > 99)).toBeUndefined()
    expect(collect<number>([]).first()).toBeUndefined()
  })

  test('last returns the tail', () => {
    expect(collect([1, 2]).last()).toBe(2)
    expect(collect<number>([]).last()).toBeUndefined()
  })

  test('contains tests with a predicate', () => {
    const numbers = collect([1, 2])

    expect(numbers.contains((value) => value === 2)).toBe(true)
    expect(numbers.contains((value) => value === 9)).toBe(false)
  })
})

describe('ordering and grouping', () => {
  test('sortBy does not mutate the original', () => {
    const original = collect([3, 1, 2])
    const sorted = original.sortBy((value) => value)

    expect(sorted.all()).toEqual([1, 2, 3])
    expect(original.all()).toEqual([3, 1, 2])
  })

  test('sortBy handles strings', () => {
    expect(
      collect(['b', 'a'])
        .sortBy((value) => value)
        .all()
    ).toEqual(['a', 'b'])
  })

  test('groupBy buckets by the returned key', () => {
    const words = collect(['apple', 'avocado', 'banana'])

    expect(words.groupBy((word) => word[0] as string)).toEqual({
      a: ['apple', 'avocado'],
      b: ['banana']
    })
  })
})

describe('escape hatches', () => {
  test('tap exposes the collection without breaking the chain', () => {
    let captured: Collection<number> | undefined
    const collection = collect([1, 2])

    const result = collection.tap((self) => {
      captured = self
    })

    expect(result).toBe(collection)
    expect(captured).toBe(collection)
  })

  test('values is an alias for all', () => {
    expect(collect([1, 2]).values()).toEqual([1, 2])
  })
})

describe('min and max on a large collection', () => {
  /**
   * `Math.min(...items.map(…))` passes every element as an argument, which throws
   * `Maximum call stack size exceeded` at a million of them — and a collection that
   * big comes from a query, which is exactly where nobody expects `min()` to be the
   * thing that fails. Walking is also 448µs → 95µs at a hundred thousand, because
   * it skips the intermediate array as well.
   */
  test('answers where spreading the arguments would have thrown', () => {
    const many = new Collection(Array.from({ length: 1_000_000 }, (_, index) => index))

    expect<number | undefined>(many.min()).toBe(0)
    expect<number | undefined>(many.max()).toBe(999_999)
  })

  test('and still reads through a key function', () => {
    const rows = new Collection([{ n: 5 }, { n: 2 }, { n: 9 }])

    expect<number | undefined>(rows.min((row) => row.n)).toBe(2)
    expect<number | undefined>(rows.max((row) => row.n)).toBe(9)
  })

  test('and an empty collection has neither', () => {
    const empty = new Collection<number>([])

    expect<number | undefined>(empty.min()).toBeUndefined()
    expect<number | undefined>(empty.max()).toBeUndefined()
  })

  test('and negative numbers are not mistaken for absent ones', () => {
    const below = new Collection([-5, -1, -9])

    expect<number | undefined>(below.min()).toBe(-9)
    expect<number | undefined>(below.max()).toBe(-1)
  })
})
