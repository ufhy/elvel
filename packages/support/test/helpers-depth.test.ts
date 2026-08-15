import { describe, expect, test } from 'bun:test'
import { Arr, Str } from '../src/index.ts'

describe('Str: inspecting', () => {
  test('is() matches wildcards, and an exact string without them', () => {
    expect(Str.is('foo*', 'foobar')).toBe(true)
    expect(Str.is('foo*', 'barfoo')).toBe(false)
    // No wildcard: an exact match, not a substring — `foo` must not match `foobar`.
    expect(Str.is('foo', 'foobar')).toBe(false)
    expect(Str.is(['a*', 'b*'], 'bee')).toBe(true)
  })

  test('isJson, isUuid, isUlid and isAscii', () => {
    expect(Str.isJson('{"a":1}')).toBe(true)
    expect(Str.isJson('{a:1}')).toBe(false)

    expect(Str.isUuid('9f8c7d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f')).toBe(true)
    // Version nibble must be 1–8 and the variant 8/9/a/b; this has neither.
    expect(Str.isUuid('9f8c7d6e-1a2b-0c3d-0e9f-0a1b2c3d4e5f')).toBe(false)

    expect(Str.isUlid(Str.ulid())).toBe(true)
    expect(Str.isUlid('not-a-ulid')).toBe(false)

    expect(Str.isAscii('plain')).toBe(true)
    expect(Str.isAscii('naïve')).toBe(false)
  })

  test('wordCount ignores runs of whitespace', () => {
    expect(Str.wordCount('  one   two \n three ')).toBe(3)
    expect(Str.wordCount('   ')).toBe(0)
  })
})

describe('Str: slicing', () => {
  test('beforeLast takes the last occurrence', () => {
    expect(Str.beforeLast('a/b/c', '/')).toBe('a/b')
    // Nothing to cut at: the whole string.
    expect(Str.beforeLast('abc', '/')).toBe('abc')
  })

  test('between and betweenFirst differ on the closing marker', () => {
    expect(Str.between('[a] and [b]', '[', ']')).toBe('a] and [b')
    // The first closing marker rather than the last.
    expect(Str.betweenFirst('[a] and [b]', '[', ']')).toBe('a')
  })

  test('charAt and take count code points, not bytes', () => {
    expect(Str.charAt('héllo', 1)).toBe('é')
    expect(Str.take('🔐🔑🗝', 2)).toBe('🔐🔑')
    // A negative length takes from the end.
    expect(Str.take('abcdef', -2)).toBe('ef')
  })

  test('excerpt gives a window around the match', () => {
    // The window is `radius` characters each side of the phrase, and the trailing
    // ellipsis appears because four characters short of the end is still short.
    expect(Str.excerpt('one two three four', 'three', 4)).toBe('...two three fou...')
    expect(Str.excerpt('one two', 'nine')).toBeUndefined()
  })
})

describe('Str: changing', () => {
  test('squish and deduplicate', () => {
    expect(Str.squish('  a   b \n c  ')).toBe('a b c')
    expect(Str.deduplicate('a--b---c', '-')).toBe('a-b-c')
  })

  test('remove and swap', () => {
    expect(Str.remove('-', 'a-b-c')).toBe('abc')
    expect(Str.remove(['-', '_'], 'a-b_c')).toBe('abc')
    expect(Str.swap({ cat: 'dog', big: 'small' }, 'the big cat')).toBe('the small dog')
  })

  test('replaceArray fills each placeholder in turn', () => {
    expect(Str.replaceArray('?', ['8:30', '9:00'], 'from ? to ?')).toBe('from 8:30 to 9:00')
    // More placeholders than values: the extras are left alone.
    expect(Str.replaceArray('?', ['x'], '? and ?')).toBe('x and ?')
  })

  test('mask hides the middle and keeps the shape', () => {
    // A negative length stops four from the end, as PHP's substr does — so the
    // last four digits survive, which is the whole point of masking a card.
    expect(Str.mask('4111111111111111', '*', 4, -4)).toBe('4111********1111')
    expect(Str.mask('ada@example.com', '*', 3)).toBe('ada************')
  })

  test('initials and wrap', () => {
    expect(Str.initials('Ada Lovelace')).toBe('AL')
    expect(Str.initials('Ada  Byron   Lovelace', '.')).toBe('A.B.L')
    expect(Str.wrap('title', '"')).toBe('"title"')
    expect(Str.wrap('body', '<p>', '</p>')).toBe('<p>body</p>')
  })

  /**
   * A ULID is sortable by creation time, which is the reason to use one.
   *
   * Two minted a second apart must compare in that order as plain strings — that
   * is the property a UUID does not have.
   */
  test('ulid is 26 characters and sorts by time', () => {
    const earlier = Str.ulid(1_000_000_000_000)
    const later = Str.ulid(1_000_000_001_000)

    expect(earlier.length).toBe(26)
    expect(earlier < later).toBe(true)
  })

  test('the doesnt* forms are the negatives', () => {
    expect(Str.doesntContain('abc', 'z')).toBe(true)
    expect(Str.doesntStartWith('abc', 'a')).toBe(false)
    expect(Str.doesntEndWith('abc', ['x', 'y'])).toBe(true)
  })
})

describe('Arr', () => {
  test('undot rebuilds what dot flattened', () => {
    const nested = { a: { b: 1 }, c: [1, 2] }

    expect(Arr.undot(Arr.dot(nested))).toEqual(nested)
  })

  test('collapse and divide', () => {
    expect<number[]>(
      Arr.collapse([
        [1, 2],
        [3, 4]
      ])
    ).toEqual([1, 2, 3, 4])
    expect(Arr.divide({ a: 1, b: 2 })).toEqual([
      ['a', 'b'],
      [1, 2]
    ])
  })

  test('pluck takes a column, and can key it by another', () => {
    const rows = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' }
    ]

    expect<unknown>(Arr.pluck(rows, 'name')).toEqual(['Ada', 'Grace'])
    expect<unknown>(Arr.pluck(rows, 'name', 'id')).toEqual({ '1': 'Ada', '2': 'Grace' })
  })

  test('keyBy and mapWithKeys', () => {
    const rows = [{ slug: 'a', n: 1 }]

    expect(Arr.keyBy(rows, 'slug').a?.n).toBe(1)
    expect(Arr.mapWithKeys(rows, (row) => [row.slug, row.n])).toEqual({ a: 1 })
  })

  test('mapSpread hands each row over as arguments', () => {
    expect(
      Arr.mapSpread(
        [
          [1, 2],
          [3, 4]
        ],
        (a, b) => a + b
      )
    ).toEqual([3, 7])
  })

  test('partition and reject', () => {
    expect(Arr.partition([1, 2, 3, 4], (n) => n % 2 === 0)).toEqual([
      [2, 4],
      [1, 3]
    ])
    expect<number[]>(Arr.reject([1, 2, 3], (n) => n === 2)).toEqual([1, 3])
  })

  test('crossJoin, prepend and pull', () => {
    // Heterogeneous by nature: one list of numbers, one of strings.
    expect<unknown>(Arr.crossJoin<number | string>([1, 2], ['a'])).toEqual([
      [1, 'a'],
      [2, 'a']
    ])
    expect<number[]>(Arr.prepend([2, 3], 1)).toEqual([1, 2, 3])

    const target = { a: { b: 1 }, c: 2 }
    expect(Arr.pull(target, 'a.b')).toBe(1)
    // Pulled means removed, not merely read.
    expect(Arr.has(target, 'a.b')).toBe(false)
  })

  test('query flattens nested values into a query string', () => {
    expect(Arr.query({ page: 2, filter: { role: 'admin' } })).toBe('page=2&filter.role=admin')
  })

  test('isList and isAssoc tell the two apart', () => {
    expect(Arr.isList([1, 2])).toBe(true)
    expect(Arr.isList({ a: 1 })).toBe(false)
    expect(Arr.isAssoc({ a: 1 })).toBe(true)
    expect(Arr.isAssoc([1])).toBe(false)
  })

  test('hasAny, sole, shuffle and random', () => {
    expect(Arr.hasAny({ a: 1 }, ['b', 'a'])).toBe(true)
    expect(Arr.hasAny({ a: 1 }, ['b'])).toBe(false)

    expect(Arr.sole([1])).toBe(1)
    expect(() => Arr.sole([1, 2])).toThrow(/found 2/)
    expect(() => Arr.sole([])).toThrow(/No matching item/)

    expect(Arr.shuffle([1, 2, 3]).sort()).toEqual([1, 2, 3])
    expect(typeof Arr.random([1, 2, 3])).toBe('number')
    expect(Arr.random([])).toBeUndefined()
  })
})
