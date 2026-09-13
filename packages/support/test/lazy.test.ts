import { describe, expect, test } from 'bun:test'
import { LazyCollection, lazy } from '../src/lazy.ts'

/** Counts how many items the source actually produced. */
function counted<T>(items: T[]): { source: () => Generator<T>; read: () => number } {
  let read = 0

  return {
    source: function* walking() {
      for (const item of items) {
        read += 1
        yield item
      }
    },
    read: () => read
  }
}

describe('what makes it lazy', () => {
  test('take reads only what it took', async () => {
    const { source, read } = counted([1, 2, 3, 4, 5])

    expect(await lazy(source).take(2).all()).toEqual([1, 2])
    expect(read()).toBe(2)
  })

  test('and a whole chain still reads only that', async () => {
    const { source, read } = counted([1, 2, 3, 4, 5, 6, 7, 8])

    const answer = await lazy(source)
      .filter((item) => item % 2 === 0)
      .map((item) => item * 10)
      .take(2)
      .all()

    expect(answer).toEqual([20, 40])
    expect(read()).toBe(4)
  })

  test('first stops at the first match', async () => {
    const { source, read } = counted([1, 2, 3, 4])

    expect(await lazy(source).first((item) => item > 2)).toBe(3)
    expect(read()).toBe(3)
  })

  /** An infinite source is the proof: nothing here may walk to the end. */
  test('an endless source is fine as long as something stops it', async () => {
    expect(
      await LazyCollection.range(1)
        .map((item) => item * 2)
        .take(3)
        .all()
    ).toEqual([2, 4, 6])
  })

  test('take(0) reads nothing at all', async () => {
    const { source, read } = counted([1, 2, 3])

    expect(await lazy(source).take(0).all()).toEqual([])
    expect(read()).toBe(0)
  })
})

describe('sources', () => {
  test('an array', async () => {
    expect(await lazy([1, 2]).all()).toEqual([1, 2])
  })

  test('an async generator, which is what the database hands over', async () => {
    async function* rows() {
      yield { id: 1 }
      yield { id: 2 }
    }

    expect(await lazy(rows).pluck('id').all()).toEqual([1, 2])
  })

  /** Walked again from the top, because a source is a source and not a buffer. */
  test('and a factory is re-walked on a second pass', async () => {
    const { source, read } = counted([1, 2])
    const items = lazy(source)

    await items.all()
    await items.all()

    expect(read()).toBe(4)
  })
})

describe('operators', () => {
  const items = () => lazy([1, 2, 3, 4, 5])

  test('filter, reject and unique', async () => {
    expect(
      await items()
        .reject((item) => item > 2)
        .all()
    ).toEqual([1, 2])
    expect(await lazy([1, 1, 2]).unique().all()).toEqual([1, 2])
  })

  test('skip, skipWhile and skipUntil', async () => {
    expect(await items().skip(3).all()).toEqual([4, 5])
    expect(
      await items()
        .skipWhile((item) => item < 3)
        .all()
    ).toEqual([3, 4, 5])
    expect(
      await items()
        .skipUntil((item) => item === 4)
        .all()
    ).toEqual([4, 5])
  })

  test('takeWhile and takeUntil', async () => {
    expect(
      await items()
        .takeWhile((item) => item < 3)
        .all()
    ).toEqual([1, 2])
    expect(
      await items()
        .takeUntil((item) => item === 3)
        .all()
    ).toEqual([1, 2])
  })

  test('chunk hands over fixed batches, the last one short', async () => {
    const batches = await items().chunk(2).all()

    expect(batches.map((batch) => batch.all())).toEqual([[1, 2], [3, 4], [5]])
  })

  test('where, whereIn and whereNotNull', async () => {
    const rows = lazy([{ id: 1 }, { id: 2 }, { id: 3 }])

    expect(await rows.where('id', 2).all()).toEqual([{ id: 2 }])
    expect(await rows.whereIn('id', [1, 3]).count()).toBe(2)
    expect(await lazy([1, null, 2]).whereNotNull().all()).toEqual([1, 2])
  })

  test('flatMap', async () => {
    expect(
      await lazy([1, 2])
        .flatMap((item) => [item, item])
        .all()
    ).toEqual([1, 1, 2, 2])
  })

  test('the aggregates', async () => {
    expect(await items().count()).toBe(5)
    expect(await items().sum()).toBe(15)
    expect(await items().min()).toBe(1)
    expect(await items().max()).toBe(5)
    expect(await items().contains((item) => item === 3)).toBe(true)
    expect(await lazy<number>([]).isEmpty()).toBe(true)
    expect(await items().reduce((carry, item) => carry + item, 100)).toBe(115)
  })

  test('collect materialises what is left', async () => {
    expect((await items().take(2).collect()).all()).toEqual([1, 2])
  })
})

describe('tapEach', () => {
  test('sees each item without holding any', async () => {
    const seen: number[] = []

    await lazy([1, 2, 3])
      .tapEach((item) => seen.push(item))
      .take(2)
      .all()

    expect(seen).toEqual([1, 2])
  })
})

describe('takeUntilTimeout', () => {
  /** What a scheduled command wants: as much as fits, and no overrun. */
  test('stops when the deadline has passed', async () => {
    expect(
      await lazy([1, 2, 3])
        .takeUntilTimeout(Date.now() - 1)
        .all()
    ).toEqual([])
    expect(
      await lazy([1, 2, 3])
        .takeUntilTimeout(Date.now() + 60_000)
        .all()
    ).toEqual([1, 2, 3])
  })
})

describe('remember', () => {
  test('a second pass costs the rows, not the query', async () => {
    const { source, read } = counted([1, 2, 3])
    const items = lazy(source).remember()

    expect(await items.all()).toEqual([1, 2, 3])
    expect(await items.all()).toEqual([1, 2, 3])
    expect(read()).toBe(3)
  })

  /** Only what was walked is held, so a partial pass does not pay for the rest. */
  test('and what was never walked is not held', async () => {
    const { source, read } = counted([1, 2, 3, 4])
    const items = lazy(source).remember()

    expect(await items.take(2).all()).toEqual([1, 2])
    expect(read()).toBe(2)

    expect(await items.all()).toEqual([1, 2, 3, 4])
    expect(read()).toBe(4)
  })
})

describe('each', () => {
  test('stops on false', async () => {
    const seen: number[] = []

    await lazy([1, 2, 3]).each((item) => {
      seen.push(item)

      return item < 2
    })

    expect(seen).toEqual([1, 2])
  })
})
