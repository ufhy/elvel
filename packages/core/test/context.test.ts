import { afterEach, describe, expect, test } from 'bun:test'
import { Context } from '../src/context.ts'
import { enterWorkContext, withoutRequestContext } from '../src/request-context.ts'

function inWork<T>(body: () => T): T {
  return withoutRequestContext(() => {
    enterWorkContext()

    return body()
  })
}

afterEach(() => {
  Context.flush()
})

describe('values', () => {
  test('add, get, has and forget', () => {
    inWork(() => {
      Context.add('request_id', 'abc')

      expect(Context.get<string>('request_id')).toBe('abc')
      expect(Context.has('request_id')).toBe(true)

      Context.forget('request_id')

      expect(Context.has('request_id')).toBe(false)
    })
  })

  test('addIf leaves what is there', () => {
    inWork(() => {
      Context.add('trace', 'first').addIf('trace', 'second')

      expect(Context.get<string>('trace')).toBe('first')
    })
  })

  test('pull reads and removes', () => {
    inWork(() => {
      Context.add('once', 1)

      expect(Context.pull<number>('once')).toBe(1)
      expect(Context.has('once')).toBe(false)
    })
  })

  test('push and pop build a list', () => {
    inWork(() => {
      Context.push('steps', 'a', 'b')

      expect(Context.get<string[]>('steps')).toEqual(['a', 'b'])
      expect(Context.pop<string>('steps')).toBe('b')
      expect(Context.get<string[]>('steps')).toEqual(['a'])
    })
  })

  test('only and except', () => {
    inWork(() => {
      Context.add('a', 1).add('b', 2)

      expect(Context.only(['a'])).toEqual({ a: 1 })
      expect(Context.except(['a'])).toEqual({ b: 2 })
    })
  })
})

/** How a tenant id travels without being printed. */
describe('hidden values', () => {
  test('are readable and never in `all()`', () => {
    inWork(() => {
      Context.add('visible', 1).addHidden('tenant', 'acme')

      expect(Context.getHidden<string>('tenant')).toBe('acme')
      expect(Context.hasHidden('tenant')).toBe(true)
      expect(Context.all()).toEqual({ visible: 1 })
      expect(Context.allHidden()).toEqual({ tenant: 'acme' })
    })
  })

  test('and can be forgotten on their own', () => {
    inWork(() => {
      Context.addHidden('tenant', 'acme')
      Context.forgetHidden('tenant')

      expect(Context.hasHidden('tenant')).toBe(false)
    })
  })
})

describe('the unit of work owns it', () => {
  test('one request does not see another request’s', () => {
    inWork(() => Context.add('request_id', 'first'))

    expect(inWork(() => Context.get<string>('request_id'))).toBeUndefined()
  })

  test('scope adds values for a body and no longer', () => {
    inWork(() => {
      Context.add('base', 1)

      Context.scope({ extra: 2 }, () => {
        expect(Context.get<number>('base')).toBe(1)
        expect(Context.get<number>('extra')).toBe(2)
      })

      expect(Context.has('extra')).toBe(false)
    })
  })
})

/** The whole point: correlating a failed job back to the request that caused it. */
describe('travelling', () => {
  test('dehydrate carries both halves, and hydrate takes them up', () => {
    const carried = inWork(() => {
      Context.add('request_id', 'abc').addHidden('tenant', 'acme')

      return Context.dehydrate()
    })

    inWork(() => {
      Context.hydrate(carried)

      expect(Context.get<string>('request_id')).toBe('abc')
      expect(Context.getHidden<string>('tenant')).toBe('acme')
    })
  })

  test('nothing to carry is undefined, not an empty payload', () => {
    expect(inWork(() => Context.dehydrate())).toBeUndefined()
  })

  test('and hydrating merges rather than replacing', () => {
    inWork(() => {
      Context.add('job_id', 'local')
      Context.hydrate({ visible: { request_id: 'abc' }, hidden: {} })

      expect(Context.all()).toEqual({ job_id: 'local', request_id: 'abc' })
    })
  })

  test('hydrating nothing is not an error', () => {
    inWork(() => {
      expect(() => Context.hydrate(undefined)).not.toThrow()
    })
  })
})
