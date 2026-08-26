import { describe, expect, test } from 'bun:test'
import { Str } from '../src/str.ts'

/**
 * The helpers added to reach `Illuminate\Support\Str`.
 *
 * Each of these is four lines somebody would otherwise write inline, and the
 * cases below are the ones those four lines get wrong: an empty needle, a
 * negative offset, an odd number of padding characters, a `match` that answers
 * `null`.
 */
describe('replacing', () => {
  test('replaceFirst and replaceLast touch one occurrence each', () => {
    expect<string>(Str.replaceFirst('a', 'b', 'banana')).toBe('bbnana')
    expect<string>(Str.replaceLast('a', 'b', 'banana')).toBe('bananb')
  })

  test('an empty needle changes nothing rather than everything', () => {
    // `''.indexOf` answers 0, so an unguarded version prefixes the subject.
    expect<string>(Str.replaceFirst('', 'x', 'banana')).toBe('banana')
    expect<string>(Str.replaceLast('', 'x', 'banana')).toBe('banana')
  })

  test('a needle that is not there is left alone', () => {
    expect<string>(Str.replaceFirst('z', 'b', 'banana')).toBe('banana')
  })

  test('replaceStart and replaceEnd only match at the ends', () => {
    expect<string>(Str.replaceStart('ban', 'x', 'banana')).toBe('xana')
    expect<string>(Str.replaceStart('ana', 'x', 'banana')).toBe('banana')
    expect<string>(Str.replaceEnd('ana', 'x', 'banana')).toBe('banx')
    expect<string>(Str.replaceEnd('ban', 'x', 'banana')).toBe('banana')
  })

  test('replaceMatches takes a pattern or a callback', () => {
    expect<string>(Str.replaceMatches(/\d+/g, 'n', 'a1b22')).toBe('anbn')
    expect<string>(Str.replaceMatches(/\d+/g, (match) => `[${match}]`, 'a1b22')).toBe('a[1]b[22]')
  })
})

describe('padding', () => {
  /**
   * The odd character goes right, which is what PHP's `str_pad` does.
   *
   * Worth pinning: the other choice looks equally reasonable and makes every test
   * ported from Laravel fail by one character.
   */
  test('padBoth puts the remainder on the right', () => {
    expect<string>(Str.padBoth('7', 5, '0')).toBe('00700')
    expect<string>(Str.padBoth('ab', 5, '-')).toBe('-ab--')
  })

  test('and does nothing when the value is already long enough', () => {
    expect<string>(Str.padBoth('abcdef', 3, '-')).toBe('abcdef')
    expect<string>(Str.padBoth('a', 5, '')).toBe('a')
  })
})

describe('case', () => {
  test('ucwords capitalises after each delimiter', () => {
    expect<string>(Str.ucwords('hello world')).toBe('Hello World')
    expect<string>(Str.ucwords('hello-world', '-')).toBe('Hello-World')
  })

  test('ucsplit breaks on capitals', () => {
    expect<string[]>(Str.ucsplit('FooBarBaz')).toEqual(['Foo', 'Bar', 'Baz'])
  })

  test('pluralStudly changes only the last word', () => {
    expect<string>(Str.pluralStudly('UserGroup')).toBe('UserGroups')
    expect<string>(Str.pluralStudly('Person')).toBe('People')
  })

  test('pascal is studly under its other name', () => {
    expect<string>(Str.pascal('hello world')).toBe(Str.studly('hello world'))
  })
})

describe('inspecting', () => {
  test('containsAll wants every needle', () => {
    expect<boolean>(Str.containsAll('the quick fox', ['quick', 'fox'])).toBe(true)
    expect<boolean>(Str.containsAll('the quick fox', ['quick', 'dog'])).toBe(false)
  })

  test('matchAll answers an array, never null', () => {
    expect<string[]>(Str.matchAll('a1b22', /\d+/)).toEqual(['1', '22'])
    expect<string[]>(Str.matchAll('abc', /\d+/)).toEqual([])
  })

  test('and a capture group wins over the whole match', () => {
    expect<string[]>(Str.matchAll('a=1 b=2', /(\w)=\d/g)).toEqual(['a', 'b'])
  })

  test('isUrl wants a scheme', () => {
    expect<boolean>(Str.isUrl('https://example.com')).toBe(true)
    expect<boolean>(Str.isUrl('example.com')).toBe(false)
    expect<boolean>(Str.isUrl('not a url at all')).toBe(false)
  })

  test('numbers keeps the digits', () => {
    expect<string>(Str.numbers('+62 812-3456')).toBe('628123456')
  })

  test('substrCount counts without a regex, and an empty needle is zero', () => {
    expect<number>(Str.substrCount('banana', 'an')).toBe(2)
    expect<number>(Str.substrCount('aaaa', 'aa')).toBe(2)
    expect<number>(Str.substrCount('banana', '')).toBe(0)
  })
})

describe('reshaping', () => {
  test('reverse handles characters beyond the BMP', () => {
    // `split('')` would break the surrogate pair; `[...value]` does not.
    expect<string>(Str.reverse('ab🌍')).toBe('🌍ba')
  })

  test('chopStart and unwrap', () => {
    expect<string>(Str.chopStart('/admin/users', '/admin')).toBe('/users')
    expect<string>(Str.chopStart('/users', ['/admin', '/api'])).toBe('/users')
    expect<string>(Str.unwrap('"quoted"', '"')).toBe('quoted')
    expect<string>(Str.unwrap('{value}', '{', '}')).toBe('value')
  })

  test('substrReplace takes a negative offset', () => {
    expect<string>(Str.substrReplace('banana', 'X', 0, 3)).toBe('Xana')
    expect<string>(Str.substrReplace('banana', 'X', -3)).toBe('banX')
  })

  test('wordWrap breaks at the width and leaves long words whole', () => {
    expect<string>(Str.wordWrap('the quick brown fox', 10)).toBe('the quick\nbrown fox')
    expect<string>(Str.wordWrap('https://a-very-long-url', 10)).toBe('https://a-very-long-url')
    expect<string>(Str.wordWrap('abcdefghij', 4, '\n', true)).toBe('abcd\nefgh\nij')
  })

  test('ltrim and rtrim take a set of characters', () => {
    expect<string>(Str.ltrim('///path', '/')).toBe('path')
    expect<string>(Str.rtrim('path///', '/')).toBe('path')
  })
})

describe('base64 and passwords', () => {
  test('base64 round-trips, including non-ASCII', () => {
    expect<string>(Str.fromBase64(Str.toBase64('hello'))).toBe('hello')
    expect<string>(Str.fromBase64(Str.toBase64('hallo, dünya 🌍'))).toBe('hallo, dünya 🌍')
  })

  /**
   * From `crypto.getRandomValues`, not `Math.random`.
   *
   * A password is a credential, and the difference between the two generators is
   * whether somebody can predict it. The test can only assert the shape and that
   * two calls differ — which is why the choice is stated in the source.
   */
  test('a password has the asked-for length and is not the same twice', () => {
    expect<number>(Str.password(24).length).toBe(24)

    const first = Str.password()
    const second = Str.password()

    expect<boolean>(first === second).toBe(false)
  })

  test('and can be narrowed to one class of character', () => {
    expect<boolean>(/^[0-9]+$/.test(Str.password(16, false, true, false))).toBe(true)
    expect<string>(Str.password(8, false, false, false)).toBe('')
  })
})
