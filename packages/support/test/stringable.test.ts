import { describe, expect, test } from 'bun:test'
// The package entry, not `str.ts`: `of` is merged on there, and the comment in
// `index.ts` says why it cannot live on the literal.
import { of, Str } from '../src/index.ts'
import { transliterate } from '../src/transliterate.ts'

describe('slug across scripts', () => {
  /**
   * Five of these nine used to produce an empty string, so every such article
   * collided on `/articles/`.
   */
  test('a title in any script produces a usable slug', () => {
    const cases: Array<[string, string]> = [
      ['Hello World', 'hello-world'],
      ['Café Ünïcode', 'cafe-unicode'],
      ['Привет мир', 'привет-мир'],
      ['Καλημέρα κόσμε', 'καλημερα-κοσμε'],
      ['你好世界', '你好世界'],
      ['한국어 제목', '한국어-제목']
    ]

    for (const [title, expected] of cases) expect(Str.slug(title)).toBe(expected)
  })

  test('and none of them is empty', () => {
    for (const title of ['Привет', 'مرحبا', '你好', 'Καλημέρα', 'שלום']) {
      expect(Str.slug(title).length).toBeGreaterThan(0)
    }
  })

  test('ascii mode romanises where that means something', () => {
    expect(Str.slug('Привет мир', '-', { ascii: true })).toBe('privet-mir')
    expect(Str.slug('Καλημέρα κόσμε', '-', { ascii: true })).toBe('kalimera-kosme')
    expect(Str.slug('Straße Größe', '-', { ascii: true })).toBe('strasse-grosse')
  })

  test('and leaves a script with no romanisation alone rather than deleting it', () => {
    expect(Str.slug('你好世界', '-', { ascii: true })).toBe('你好世界')
  })

  test('punctuation still goes', () => {
    expect(Str.slug('Hello, World! (2026)')).toBe('hello-world-2026')
  })

  test('a separator other than a dash', () => {
    expect(Str.slug('Hello World', '_')).toBe('hello_world')
  })
})

describe('transliterate', () => {
  test('keeps the case of the first letter', () => {
    expect(transliterate('Привет')).toBe('Privet')
    expect(transliterate('привет')).toBe('privet')
  })

  test('and returns anything it cannot romanise unchanged', () => {
    expect(transliterate('你好')).toBe('你好')
  })
})

describe('the chain basics Str gained', () => {
  test('trim, with and without characters', () => {
    expect(Str.trim('  a  ')).toBe('a')
    expect(Str.trim('xxaxx', 'x')).toBe('a')
  })

  test('replace is literal for a string needle', () => {
    expect(Str.replace('a.b.c', '.', '-')).toBe('a-b-c')
    expect(Str.replace('a1b2c', /\d/g, '')).toBe('abc')
  })

  test('substr reads a negative offset and a negative length', () => {
    expect(Str.substr('abcdef', -3)).toBe('def')
    expect(Str.substr('abcdef', 1, 3)).toBe('bcd')
    expect(Str.substr('abcdef', 1, -1)).toBe('bcde')
  })

  /** `-1` is a valid index, so a miss cannot be spelt that way. */
  test('position answers false rather than -1', () => {
    expect(Str.position('abc', 'z')).toBe(false)
    expect(Str.position('abc', 'a')).toBe(0)
  })

  test('length counts characters, not code units', () => {
    expect(Str.length('👋ab')).toBe(3)
  })
})

describe('Stringable', () => {
  test('the chain reads left to right', () => {
    expect(Str.of('  Hello Beautiful World  ').trim().slug().toString()).toBe(
      'hello-beautiful-world'
    )
  })

  test('a method that answers a boolean ends the chain', () => {
    expect(Str.of('elvel').startsWith('el')).toBe(true)
    expect(Str.of('elvel').contains('lv')).toBe(true)
  })

  test('and one that answers an array does too', () => {
    expect(Str.of('helloWorld').words()).toEqual(['hello', 'World'])
  })

  test('explode keeps the chain on every part', () => {
    expect(
      Str.of('a,b,c')
        .explode(',')
        .map((part) => part.upper().toString())
    ).toEqual(['A', 'B', 'C'])
  })

  test('when and unless', () => {
    expect(
      Str.of('ada')
        .when(true, (v) => v.title())
        .toString()
    ).toBe('Ada')
    expect(
      Str.of('ada')
        .when(false, (v) => v.title())
        .toString()
    ).toBe('ada')
    expect(
      Str.of('ada')
        .unless(false, (v) => v.upper())
        .toString()
    ).toBe('ADA')
  })

  test('the condition may be a callback over the subject', () => {
    expect(
      Str.of('a very long title indeed')
        .when(
          (value) => value.length > 10,
          (v) => v.limit(10)
        )
        .toString()
    ).toBe('a very lon...')
  })

  test('whenEmpty and whenNotEmpty', () => {
    expect(
      Str.of('')
        .whenEmpty((v) => v.append('fallback'))
        .toString()
    ).toBe('fallback')
    expect(
      Str.of('x')
        .whenEmpty((v) => v.append('fallback'))
        .toString()
    ).toBe('x')
  })

  test('pipe and tap', () => {
    const seen: string[] = []

    expect(
      Str.of('ada')
        .tap((value) => seen.push(value))
        .pipe((value) => `${value}!`)
        .toString()
    ).toBe('ada!')

    expect(seen).toEqual(['ada'])
  })

  test('it interpolates and serialises as its string', () => {
    expect(`${Str.of('ada').title()}`).toBe('Ada')
    expect(JSON.stringify({ name: Str.of('ada') })).toBe('{"name":"ada"}')
    expect(Str.of('abc').length).toBe(3)
  })

  /**
   * The projection is the point: a method added to `Str` is chainable without
   * being written twice, and `Str.of` itself must not be one of them.
   */
  test('every string-first Str method is on the chain, and `of` is not', () => {
    // `length` is a property on the chain and a function on `Str`; the
    // property wins, so it is not part of this sweep.
    const chainable = Object.keys(Str).filter((name) => name !== 'of' && name !== 'length')
    const instance = of('x') as unknown as Record<string, unknown>

    for (const name of chainable) expect(typeof instance[name]).toBe('function')

    expect((instance as { of?: unknown }).of).toBeUndefined()
  })
})
