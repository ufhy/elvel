import { describe, expect, test } from 'bun:test'
import { Collection, collect } from '../src/collection.ts'

describe('filters', () => {
  const rows = collect([
    { name: 'a', score: 10 },
    { name: 'b', score: 20 },
    { name: 'c', score: 30 }
  ])

  /** Inclusive at both ends, which is what a range read out of a form means. */
  test('whereBetween includes both ends', () => {
    expect(rows.whereBetween('score', [10, 20]).pluck('name').all()).toEqual(['a', 'b'])
  })

  test('whereNotBetween is its complement', () => {
    expect(rows.whereNotBetween('score', [10, 20]).pluck('name').all()).toEqual(['c'])
  })

  test('whereInstanceOf narrows the type as it filters', () => {
    class Cat {
      readonly kind = 'cat'
    }
    class Dog {
      readonly kind = 'dog'
    }

    const pets = collect<Cat | Dog>([new Cat(), new Dog(), new Cat()])
    const cats = pets.whereInstanceOf(Cat)

    expect(cats.count()).toBe(2)
    expect(cats.first()?.kind).toBe('cat')
  })

  test('forPage counts from page one', () => {
    expect(collect([1, 2, 3, 4, 5]).forPage(2, 2).all()).toEqual([3, 4])
    expect(collect([1, 2, 3]).forPage(9, 2).all()).toEqual([])
  })
})

describe('shapers', () => {
  test('mapInto builds one of these out of every item', () => {
    class Point {
      constructor(readonly value: number) {}
    }

    expect(collect([1, 2]).mapInto(Point).first()?.value).toBe(1)
  })

  /** Each item is an argument list, not one argument — what `zip` leaves behind. */
  test('mapSpread spreads each item', () => {
    const pairs = collect<[number, string]>([
      [1, 'a'],
      [2, 'b']
    ])

    expect(pairs.mapSpread((left, right) => `${left}${right}`).all()).toEqual(['1a', '2b'])
  })

  test('eachSpread stops on false', () => {
    const seen: string[] = []

    collect<[string, number]>([
      ['a', 1],
      ['b', 2]
    ]).eachSpread((letter) => {
      seen.push(letter)

      return false
    })

    expect(seen).toEqual(['a'])
  })

  test('reduceSpread carries a value across the pairs', () => {
    const total = collect<[number, number]>([
      [1, 2],
      [3, 4]
    ]).reduceSpread<[number, number], number>((carry, left, right) => carry + left * right, 0)

    expect(total).toBe(14)
  })

  test('pipeInto hands the whole thing to a constructor', () => {
    class Summary {
      constructor(readonly items: Collection<number>) {}
    }

    expect(collect([1, 2]).pipeInto(Summary).items.count()).toBe(2)
  })

  test('pipeThrough runs each callback on what the last returned', () => {
    const answer = collect([1, 2, 3]).pipeThrough<number>([
      (items: Collection<number>) => items.filter((item) => item > 1),
      (items: Collection<number>) => items.sum()
    ])

    expect(answer).toBe(5)
  })
})

describe('the ones that mutate', () => {
  test('splice cuts a run out and returns it', () => {
    const items = collect([1, 2, 3, 4])

    expect(items.splice(1, 2).all()).toEqual([2, 3])
    expect(items.all()).toEqual([1, 4])
  })

  test('and can put something in its place', () => {
    const items = collect([1, 2, 3])
    items.splice(1, 1, [9, 9])

    expect(items.all()).toEqual([1, 9, 9, 3])
  })

  test('transform maps in place', () => {
    const items = collect([1, 2])

    expect(items.transform((item) => item * 10)).toBe(items)
    expect(items.all()).toEqual([10, 20])
  })

  test('unshift adds to the front', () => {
    expect(collect([2]).unshift(0, 1).all()).toEqual([0, 1, 2])
  })
})

/** A collection built from JSON is whatever arrived, not what the type says. */
describe('ensure', () => {
  test('passes when every item is right', () => {
    expect(collect([1, 2]).ensure('number').count()).toBe(2)
  })

  test('and says which item is not', () => {
    expect(() => collect([1, 'two']).ensure('number')).toThrow('Item at 1 should be number')
  })

  test('a class works too', () => {
    class Point {}

    expect(() => collect([new Point(), {}]).ensure(Point)).toThrow('Item at 1 should be Point')
  })
})

describe('aggregates', () => {
  test('percentage is a share of the items', () => {
    expect(collect([1, 2, 3, 4]).percentage((item) => item > 2)).toBe(50)
    expect(collect([1, 2, 3]).percentage((item) => item > 2)).toBe(33.33)
  })

  test('and an empty collection has none, rather than zero', () => {
    expect(collect<number>([]).percentage(() => true)).toBeUndefined()
  })

  test('mode is the commonest value', () => {
    expect(collect([1, 2, 2, 3]).mode()).toEqual([2])
  })

  test('and a tie returns all of them', () => {
    expect(collect([1, 1, 2, 2]).mode()).toEqual([1, 2])
  })

  test('chunkBy breaks into runs of the same value', () => {
    const runs = collect([1, 1, 2, 3, 3]).chunkBy((item) => item)

    expect(runs.map((chunk) => chunk.all()).all()).toEqual([[1, 1], [2], [3, 3]])
  })
})

describe('json', () => {
  test('round trips', () => {
    const json = collect([{ id: 1 }]).toJson()

    expect(json).toBe('[{"id":1}]')
    expect(Collection.fromJson<{ id: number }>(json).first()).toEqual({ id: 1 })
  })

  test('and pretty is for a fixture, where one long line is unreadable', () => {
    expect(collect([1]).toPrettyJson()).toBe('[\n  1\n]')
  })

  test('anything but a JSON array is refused', () => {
    expect(() => Collection.fromJson('{"a":1}')).toThrow('built from a JSON array')
  })
})

describe('value', () => {
  test('hands the collection over and takes back the answer', () => {
    expect(collect([1, 2, 3]).value((items) => items.sum() > 5)).toBe(true)
  })
})
