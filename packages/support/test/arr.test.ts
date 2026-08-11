import { describe, expect, test } from 'bun:test'
import { Arr } from '../src/arr.ts'

describe('Arr dot access', () => {
  const source = { app: { name: 'Elysian', nested: { debug: false } }, list: [1, 2] }

  test('get', () => {
    // Without a fallback the return type is `unknown`, so name the type here.
    expect(Arr.get<string>(source, 'app.name')).toBe('Elysian')
    expect(Arr.get<boolean>(source, 'app.nested.debug')).toBe(false)
    expect(Arr.get(source, 'app.missing', 'fallback')).toBe('fallback')
    expect(Arr.get(source, 'app.name.deeper', 'fallback')).toBe('fallback')
  })

  test('get returns the fallback for a key whose value is undefined', () => {
    expect(Arr.get({ path: undefined }, 'path', '/default')).toBe('/default')
  })

  test('set creates intermediate objects', () => {
    const target: Record<string, unknown> = {}
    Arr.set(target, 'view.cache.enabled', true)

    expect(target).toEqual({ view: { cache: { enabled: true } } })
  })

  test('has', () => {
    expect(Arr.has(source, 'app.nested.debug')).toBe(true)
    expect(Arr.has(source, 'app.nope')).toBe(false)
  })

  test('dot flattens', () => {
    expect(Arr.dot(source)).toEqual({
      'app.name': 'Elysian',
      'app.nested.debug': false,
      list: [1, 2]
    })
  })
})
