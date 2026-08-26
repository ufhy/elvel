import { describe, expect, test } from 'bun:test'
import { Collection } from '../src/collection.ts'

/**
 * The methods added to reach `Illuminate\Support\Collection`.
 *
 * What is *not* here is as deliberate: `splice` and `transform` mutate, and the
 * type system charges for them — a `T[]` parameter or a `(item: T) => T` callback
 * makes this class invariant in `T`, and `Collection<Model>` then stops being
 * assignable to `Collection<Article>`. Adding them broke six casts in the
 * database package. `map()` into a new collection says the same thing.
 *
 * `before` and `after` take `unknown` rather than `T` for the same reason, which
 * the source explains at more length.
 */
const of = <T>(...items: T[]) => new Collection(items)

describe('the contains family', () => {
  test('doesntContain is the negation', () => {
    const numbers = of(1, 2, 3)

    expect<boolean>(numbers.doesntContain((n) => n === 4)).toBe(true)
    expect<boolean>(numbers.doesntContain((n) => n === 2)).toBe(false)
  })

  /**
   * The "strict" pair are aliases, and the reason is worth stating.
   *
   * In PHP `contains` compares loosely, so `containsStrict` opts out of `'1' == 1`.
   * There is no loose comparison here to opt out of — but the names exist so an
   * example copies across without a reader hunting for what changed.
   */
  test('the strict twins answer the same, because nothing here is loose', () => {
    const numbers = of(1, 2, 3)

    expect<boolean>(numbers.containsStrict((n) => n === 2)).toBe(true)
    expect<boolean>(numbers.doesntContainStrict((n) => n === 9)).toBe(true)
  })

  test('containsOneItem and containsManyItems', () => {
    expect<boolean>(of(1).containsOneItem()).toBe(true)
    expect<boolean>(of(1, 2).containsOneItem()).toBe(false)
    expect<boolean>(of(1, 2).containsManyItems()).toBe(true)
    expect<boolean>(of<number>().containsManyItems()).toBe(false)
  })
})

describe('select', () => {
  test('narrows each item to the named keys', () => {
    const people = of({ id: 1, name: 'Ada', secret: 'x' }, { id: 2, name: 'Grace', secret: 'y' })

    expect<unknown>(people.select(['id', 'name']).all()).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' }
    ])
  })

  test('and is where pluck cannot help, because pluck takes one key', () => {
    const people = of({ id: 1, name: 'Ada' })

    expect<unknown>(people.pluck('name').all()).toEqual(['Ada'])
    expect<unknown>(people.select(['id', 'name']).first()).toEqual({ id: 1, name: 'Ada' })
  })
})

describe('before and after', () => {
  test('answer the neighbour, and nothing at the ends', () => {
    const letters = of('a', 'b', 'c')

    expect<string | undefined>(letters.before('b')).toBe('a')
    expect<string | undefined>(letters.after('b')).toBe('c')
    expect<string | undefined>(letters.before('a')).toBeUndefined()
    expect<string | undefined>(letters.after('c')).toBeUndefined()
  })

  test('a value that is not there answers nothing rather than the first item', () => {
    expect<string | undefined>(of('a', 'b').before('z')).toBeUndefined()
    expect<string | undefined>(of('a', 'b').after('z')).toBeUndefined()
  })

  test('and a predicate works where a value cannot', () => {
    const people = of({ name: 'Ada' }, { name: 'Grace' }, { name: 'Alan' })

    expect<unknown>(people.after((person) => person.name === 'Ada')).toEqual({ name: 'Grace' })
  })
})

describe('splitIn and multiply', () => {
  /**
   * `split` balances the groups; `splitIn` fills each before starting the next.
   *
   * The difference is the whole reason both exist: laying out three columns wants
   * `split`, paging wants `splitIn`.
   */
  test('splitIn fills each group before the next', () => {
    const grouped = of(1, 2, 3, 4, 5).splitIn(2)

    expect<unknown>(grouped.map((group) => group.all()).all()).toEqual([
      [1, 2, 3],
      [4, 5]
    ])
  })

  test('multiply repeats the collection', () => {
    expect<number[]>(of(1, 2).multiply(3).all()).toEqual([1, 2, 1, 2, 1, 2])
    expect<number[]>(of(1, 2).multiply(0).all()).toEqual([])
    expect<number[]>(of(1, 2).multiply(-1).all()).toEqual([])
  })
})

describe('hasSole and firstOrFail', () => {
  test('hasSole asks what sole throws about', () => {
    expect<boolean>(of(1).hasSole()).toBe(true)
    expect<boolean>(of(1, 2).hasSole()).toBe(false)
    expect<boolean>(of(1, 2, 3).hasSole((n) => n === 2)).toBe(true)
  })

  test('firstOrFail throws where first answers undefined', () => {
    expect<number>(of(1, 2).firstOrFail()).toBe(1)
    expect<number>(of(1, 2, 3).firstOrFail((n) => n > 2)).toBe(3)
    expect(() => of<number>().firstOrFail()).toThrow()
    expect(() => of(1, 2).firstOrFail((n) => n > 9)).toThrow()
  })
})

describe('duplicatesStrict', () => {
  test('is duplicates under its other name', () => {
    expect<number[]>(of(1, 2, 2, 3, 3).duplicatesStrict().all()).toEqual([2, 3])
  })
})
