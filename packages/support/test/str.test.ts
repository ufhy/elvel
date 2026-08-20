import { describe, expect, test } from 'bun:test'
import { Str } from '../src/str.ts'

describe('Str casing', () => {
  test('studly', () => {
    expect(Str.studly('hello world')).toBe('HelloWorld')
    expect(Str.studly('send_reports')).toBe('SendReports')
    expect(Str.studly('send-reports')).toBe('SendReports')
    expect(Str.studly('sendReports')).toBe('SendReports')
  })

  test('camel', () => {
    expect(Str.camel('send_reports')).toBe('sendReports')
    expect(Str.camel('SendReports')).toBe('sendReports')
  })

  test('snake and kebab', () => {
    expect(Str.snake('SendReports')).toBe('send_reports')
    expect(Str.snake('SendReports', ':')).toBe('send:reports')
    expect(Str.kebab('SendReports')).toBe('send-reports')
    expect(Str.kebab('HTTPResponse')).toBe('http-response')
  })

  test('headline', () => {
    expect(Str.headline('pages.about')).toBe('Pages About')
    expect(Str.headline('sendReports')).toBe('Send Reports')
  })

  test('slug', () => {
    expect(Str.slug('Héllo World!')).toBe('hello-world')
    expect(Str.slug('Hello   World', '_')).toBe('hello_world')
  })
})

describe('Str inflection', () => {
  test('plural', () => {
    expect(Str.plural('post')).toBe('posts')
    expect(Str.plural('box')).toBe('boxes')
    expect(Str.plural('category')).toBe('categories')
    expect(Str.plural('person')).toBe('people')
    expect(Str.plural('sheep')).toBe('sheep')
  })

  test('singular', () => {
    expect(Str.singular('posts')).toBe('post')
    expect(Str.singular('boxes')).toBe('box')
    expect(Str.singular('categories')).toBe('category')
    expect(Str.singular('people')).toBe('person')
    expect(Str.singular('sheep')).toBe('sheep')
  })

  test('preserves case of irregular forms', () => {
    expect(Str.plural('Person')).toBe('People')
  })
})

describe('Str utilities', () => {
  test('before / after / afterLast', () => {
    expect(Str.before('admin/reports/index', '/')).toBe('admin')
    expect(Str.after('admin/reports/index', '/')).toBe('reports/index')
    expect(Str.afterLast('admin/reports/index', '/')).toBe('index')
    expect(Str.afterLast('index', '/')).toBe('index')
  })

  test('chopEnd', () => {
    expect(Str.chopEnd('PostController', 'Controller')).toBe('Post')
    expect(Str.chopEnd('Post', 'Controller')).toBe('Post')
  })

  test('replacePlaceholders leaves unknown keys untouched', () => {
    const stub = 'class {{ class }} extends {{ base }} // {{ unknown }}'

    expect(Str.replacePlaceholders(stub, { class: 'Foo', base: 'Bar' })).toBe(
      'class Foo extends Bar // {{ unknown }}'
    )
  })

  test('random draws evenly, throwing away the bytes that would not', () => {
    // The alphabet is 62 long and a byte holds 256 values, so 248 and above have
    // no even home: `byte % 62` would fold them back onto 'a'–'h' and make those
    // eight letters a quarter more likely than the rest. This is what mints
    // session identifiers and CSRF tokens, so it redraws instead.
    //
    // Fed one wrapping byte per candidate followed by 0, 1, 2, an even draw can
    // only answer 'abc'; a modulo would have answered 'aab' — 248 % 62 is 0.
    const real = crypto.getRandomValues
    const feed = [248, 0, 255, 1, 250, 2]
    let next = 0

    crypto.getRandomValues = (<T extends ArrayBufferView>(into: T) => {
      const bytes = new Uint8Array(into.buffer, into.byteOffset, into.byteLength)
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = feed[next % feed.length] as number
        next += 1
      }
      return into
    }) as typeof crypto.getRandomValues

    try {
      expect(Str.random(3)).toBe('abc')
    } finally {
      crypto.getRandomValues = real
    }
  })

  test('random is the length asked for, out of the alphabet promised', () => {
    expect(Str.random(40)).toHaveLength(40)
    expect(Str.random(1)).toHaveLength(1)
    expect(Str.random(64)).toMatch(/^[a-zA-Z0-9]{64}$/)
  })
})
