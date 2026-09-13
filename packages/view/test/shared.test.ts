import { describe, expect, test } from 'bun:test'
import { enterWorkContext, withoutRequestContext } from '@elvel/core'
import { shared, sharedValue } from '../src/shared.ts'

/** One unit of work, the way a request or a job opens one. */
function inRequest<T>(body: () => T): T {
  return withoutRequestContext(() => {
    enterWorkContext()

    return body()
  })
}

describe('shared', () => {
  test('computes on first read and remembers it for the request', () => {
    let computed = 0
    const unread = shared(() => ++computed)

    inRequest(() => {
      expect(unread()).toBe(1)
      expect(unread()).toBe(1)
    })

    expect(computed).toBe(1)
  })

  /** A page that never reads it never pays for it. */
  test('and a page that does not read it never computes it', () => {
    let computed = 0
    shared(() => ++computed)

    inRequest(() => undefined)

    expect(computed).toBe(0)
  })

  test('the next request computes its own', () => {
    let computed = 0
    const unread = shared(() => ++computed)

    expect(inRequest(unread)).toBe(1)
    expect(inRequest(unread)).toBe(2)
  })

  test('two shared values do not collide', () => {
    const first = shared(() => 'a')
    const second = shared(() => 'b')

    inRequest(() => {
      expect(first()).toBe('a')
      expect(second()).toBe('b')
    })
  })

  /** A mail rendered from a worker, a page rendered in a command. */
  test('outside a request it is computed per call', () => {
    let computed = 0
    const unread = shared(() => ++computed)

    expect(unread()).toBe(1)
    expect(unread()).toBe(2)
  })
})

describe('sharedValue', () => {
  test('a middleware sets it and a component reads it', () => {
    const tenant = sharedValue('public')

    inRequest(() => {
      expect(tenant()).toBe('public')

      tenant.set('acme')

      expect(tenant()).toBe('acme')
    })
  })

  test('and it does not leak into the next request', () => {
    const tenant = sharedValue('public')

    inRequest(() => tenant.set('acme'))

    expect(inRequest(tenant)).toBe('public')
  })

  /** A component rendered outside a request is a legitimate thing to do. */
  test('reading with nothing set answers with the default', () => {
    const tenant = sharedValue('public')

    expect(tenant()).toBe('public')
  })
})
