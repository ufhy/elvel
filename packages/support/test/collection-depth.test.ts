import { describe, expect, test } from 'bun:test'
import { Collection, collect, ItemNotFoundError, MultipleItemsFoundError } from '../src/index.ts'

type Person = { name: string; role: string; age: number }

const people: Person[] = [
  { name: 'Ada', role: 'admin', age: 36 },
  { name: 'Grace', role: 'admin', age: 45 },
  { name: 'Alan', role: 'user', age: 41 },
  { name: 'Edsger', role: 'user', age: 30 }
]

describe('building', () => {
  test('times, range and wrap', () => {
    expect<number[]>(Collection.times(3, (n) => n * 2).all()).toEqual([2, 4, 6])
    expect<number[]>(Collection.range(1, 4).all()).toEqual([1, 2, 3, 4])
    // Counting down, which a naive implementation gets wrong.
    expect<number[]>(Collection.range(3, 1).all()).toEqual([3, 2, 1])

    expect<number[]>(Collection.wrap(5).all()).toEqual([5])
    expect<number[]>(Collection.wrap([1, 2]).all()).toEqual([1, 2])
    expect<number[]>(Collection.wrap<number>(null).all()).toEqual([])
    // Already a collection: handed back rather than nested.
    const existing = collect([1])
    expect(Collection.wrap(existing)).toBe(existing)
  })
})

describe('selecting', () => {
  test('sole insists on exactly one', () => {
    expect(collect(people).sole((one) => one.name === 'Ada').age).toBe(36)

    // The point: `first()` would have answered happily in both of these.
    expect(() => collect(people).sole((one) => one.role === 'admin')).toThrow(
      MultipleItemsFoundError
    )
    expect(() => collect(people).sole((one) => one.name === 'Nobody')).toThrow(ItemNotFoundError)
  })

  test('where, whereIn and firstWhere', () => {
    expect(collect(people).where('role', 'admin').count()).toBe(2)
    expect(collect(people).whereIn('name', ['Ada', 'Alan']).count()).toBe(2)
    expect(collect(people).whereNotIn('name', ['Ada', 'Alan']).count()).toBe(2)
    expect(collect(people).firstWhere('role', 'user')?.name).toBe('Alan')
  })

  test('whereNull treats undefined as null, because JSON does', () => {
    const rows = [{ at: null }, { at: undefined }, { at: '2026-01-01' }]

    expect(collect(rows).whereNull('at').count()).toBe(2)
    expect(collect(rows).whereNotNull('at').count()).toBe(1)
  })

  test('only, except and nth', () => {
    expect<number[]>(collect([1, 2, 3, 4]).only([0, 2]).all()).toEqual([1, 3])
    expect<number[]>(collect([1, 2, 3, 4]).except([0, 2]).all()).toEqual([2, 4])
    expect<number[]>(collect([1, 2, 3, 4, 5, 6]).nth(2).all()).toEqual([1, 3, 5])
    expect<number[]>(collect([1, 2, 3, 4, 5, 6]).nth(2, 1).all()).toEqual([2, 4, 6])
  })

  test('search takes a value or a predicate', () => {
    expect(collect(['a', 'b', 'c']).search('b')).toBe(1)
    expect(collect(['a', 'b']).search('z')).toBe(false)
    expect(collect(people).search((one) => one.age > 40)).toBe(1)
  })
})

describe('slicing', () => {
  test('skip and take, with their while and until forms', () => {
    const numbers = collect([1, 2, 3, 4, 1])

    expect<number[]>(numbers.skip(2).all()).toEqual([3, 4, 1])
    expect<number[]>(numbers.skipWhile((n) => n < 3).all()).toEqual([3, 4, 1])
    expect<number[]>(numbers.skipUntil((n) => n > 3).all()).toEqual([4, 1])
    expect<number[]>(numbers.takeWhile((n) => n < 3).all()).toEqual([1, 2])
    expect<number[]>(numbers.takeUntil((n) => n > 3).all()).toEqual([1, 2, 3])
  })

  test('chunk splits into fixed sizes, with a short last one', () => {
    const chunks = collect([1, 2, 3, 4, 5]).chunk(2)

    expect(chunks.count()).toBe(3)
    expect<number[]>(chunks.last()?.all() ?? []).toEqual([5])
    expect(() => collect([1]).chunk(0)).toThrow(/at least 1/)
  })

  /**
   * The one `groupBy` cannot do.
   *
   * A run is about adjacency: these are consecutive ascending stretches, and two
   * separate runs of the same values must stay separate.
   */
  test('chunkWhile groups consecutive runs', () => {
    const runs = collect([1, 2, 3, 7, 8, 1]).chunkWhile((item, _index, chunk) => {
      const previous = chunk.last() as number

      return item === previous + 1
    })

    expect(runs.map((run) => run.all()).all()).toEqual([[1, 2, 3], [7, 8], [1]])
  })

  test('sliding gives overlapping windows', () => {
    expect(
      collect([1, 2, 3, 4])
        .sliding(2)
        .map((w) => w.all())
        .all()
    ).toEqual([
      [1, 2],
      [2, 3],
      [3, 4]
    ])

    expect(
      collect([1, 2, 3, 4, 5])
        .sliding(2, 2)
        .map((w) => w.all())
        .all()
    ).toEqual([
      [1, 2],
      [3, 4]
    ])
  })

  test('split shares the remainder across the first groups', () => {
    const groups = collect([1, 2, 3, 4, 5]).split(3)

    // Not [1,2] [3,4] [5]: the extra goes to the front, as Laravel does it.
    expect(groups.map((g) => g.all()).all()).toEqual([[1, 2], [3, 4], [5]])
  })

  test('partition returns both halves', () => {
    const [admins, rest] = collect(people).partition((one) => one.role === 'admin')

    expect(admins.count()).toBe(2)
    expect(rest.count()).toBe(2)
  })
})

describe('reshaping', () => {
  test('collapse goes one level, flatten goes all the way', () => {
    expect<number[]>(
      collect([
        [1, 2],
        [3, 4]
      ])
        .collapse()
        .all()
    ).toEqual([1, 2, 3, 4])

    expect(
      collect([1, [2, [3, [4]]]])
        .flatten()
        .all()
    ).toEqual([1, 2, 3, 4])
    expect(
      collect([1, [2, [3, [4]]]])
        .flatten(1)
        .all()
    ).toEqual([1, 2, [3, [4]]])
  })

  test('keyBy and mapWithKeys', () => {
    expect(collect(people).keyBy((one) => one.name).Ada?.age).toBe(36)
    expect(collect(people).mapWithKeys((one) => [one.name, one.age]).Grace).toBe(45)
  })

  test('countBy and duplicates', () => {
    expect(collect(people).countBy((one) => one.role)).toEqual({ admin: 2, user: 2 })
    expect<number[]>(collect([1, 2, 2, 3, 3, 3]).duplicates().all()).toEqual([2, 3, 3])
  })

  test('zip pairs by index and pads with undefined', () => {
    expect(collect([1, 2, 3]).zip(['a', 'b']).all()).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, undefined]
    ])
  })

  test('crossJoin makes every combination', () => {
    expect(collect([1, 2]).crossJoin(['a', 'b']).all()).toEqual([
      [1, 'a'],
      [1, 'b'],
      [2, 'a'],
      [2, 'b']
    ])
  })

  test('pad fills to length, and a negative size pads the front', () => {
    expect<number[]>(collect([1, 2]).pad(4, 0).all()).toEqual([1, 2, 0, 0])
    expect<number[]>(collect([1, 2]).pad(-4, 0).all()).toEqual([0, 0, 1, 2])
    // Already long enough: unchanged.
    expect<number[]>(collect([1, 2, 3]).pad(2, 0).all()).toEqual([1, 2, 3])
  })

  test('diff, intersect and uniqueBy', () => {
    expect<number[]>(collect([1, 2, 3]).diff([2]).all()).toEqual([1, 3])
    expect<number[]>(collect([1, 2, 3]).intersect([2, 3, 9]).all()).toEqual([2, 3])
    expect(
      collect(people)
        .uniqueBy((one) => one.role)
        .count()
    ).toBe(2)
  })
})

describe('arithmetic', () => {
  test('sum, avg, min and max', () => {
    expect(collect([1, 2, 3]).sum()).toBe(6)
    expect(collect(people).sum((one) => one.age)).toBe(152)
    expect(collect(people).avg((one) => one.age)).toBe(38)
    expect(collect(people).min((one) => one.age)).toBe(30)
    expect(collect(people).max((one) => one.age)).toBe(45)
  })

  test('an empty collection has no average, rather than zero', () => {
    // Zero would be a lie: it is a number nobody measured.
    expect(collect<number>([]).avg()).toBeUndefined()
    expect(collect<number>([]).min()).toBeUndefined()
    expect(collect([]).sum()).toBe(0)
  })

  test('median averages the two middles for an even count', () => {
    expect(collect([1, 2, 3]).median()).toBe(2)
    // Not 2: taking the lower middle is a different statistic.
    expect(collect([1, 2, 3, 4]).median()).toBe(2.5)
  })
})

describe('ordering', () => {
  test('sort, sortDesc and sortByDesc', () => {
    expect<number[]>(
      collect([3, 1, 2])
        .sort((a, b) => a - b)
        .all()
    ).toEqual([1, 2, 3])
    expect<number[]>(collect([1, 3, 2]).sortDesc().all()).toEqual([3, 2, 1])
    expect(
      collect(people)
        .sortByDesc((one) => one.age)
        .first()?.name
    ).toBe('Grace')
  })

  test('shuffle keeps every item', () => {
    const shuffled = collect([1, 2, 3, 4, 5]).shuffle()

    expect(shuffled.count()).toBe(5)
    expect<number[]>(shuffled.sort((a, b) => a - b).all()).toEqual([1, 2, 3, 4, 5])
  })

  test('random takes one or several, and nothing from nothing', () => {
    expect(typeof collect([1, 2, 3]).random()).toBe('number')
    expect((collect([1, 2, 3]).random(2) as Collection<number>).count()).toBe(2)
    expect(collect([]).random()).toBeUndefined()
  })
})

describe('mutating and flow', () => {
  test('push, prepend, pop and shift change the collection', () => {
    const items = collect([2, 3])

    items.push(4).prepend(1)

    expect<number[]>(items.all()).toEqual([1, 2, 3, 4])
    expect(items.pop()).toBe(4)
    expect(items.shift()).toBe(1)
    expect<number[]>(items.all()).toEqual([2, 3])
  })

  test('when and unless branch without breaking the chain', () => {
    const sorted = (yes: boolean) =>
      collect([3, 1, 2])
        .when(yes, (one) => one.sort((a, b) => a - b))
        .all()

    expect<number[]>(sorted(true)).toEqual([1, 2, 3])
    expect<number[]>(sorted(false)).toEqual([3, 1, 2])
    expect<number[]>(
      collect([3, 1])
        .unless(true, (one) => one.sort())
        .all()
    ).toEqual([3, 1])
  })

  test('pipe hands the whole collection over', () => {
    expect(collect([1, 2, 3]).pipe((one) => one.sum())).toBe(6)
  })

  test('every and some', () => {
    expect(collect(people).every((one) => one.age > 20)).toBe(true)
    expect(collect(people).some((one) => one.age > 44)).toBe(true)
  })

  test('implode and join, with a different last separator', () => {
    expect(collect(people).implode(', ', (one) => one.name)).toBe('Ada, Grace, Alan, Edsger')
    expect(collect(['a', 'b', 'c']).join(', ', ' and ')).toBe('a, b and c')
    // Fewer than two items: the last separator has nothing to separate.
    expect(collect(['a']).join(', ', ' and ')).toBe('a')
  })
})
