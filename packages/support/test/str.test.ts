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
})
