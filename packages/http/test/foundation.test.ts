import { describe, expect, test } from 'bun:test'
import { Application, CARRIES_RESPONSE, enterWorkContext, withoutRequestContext } from '@elvel/core'
import { Elysia } from 'elysia'
import { FormRequest, validateRequest } from '../src/form-request.ts'
import { normalise, normaliseInputPlugin } from '../src/normalise-input.ts'
import { isPrecognitive, narrowRules, validateOnly } from '../src/precognition.ts'
import { RouteBusyError, releaseRouteLock, routeLock } from '../src/route-lock.ts'

const trimAll = (value: unknown, except: string[] = []) =>
  normalise(value, new Set(except), true, true)

describe('normalising input', () => {
  /** `where('email', input)` misses the row when the space was stored with it. */
  test('trims what came in', () => {
    expect(trimAll({ email: '  ada@example.com  ' })).toEqual({ email: 'ada@example.com' })
  })

  /** A nullable column gets an empty string, and `nullable` validation passes it. */
  test('an empty field becomes nothing', () => {
    expect(trimAll({ bio: '', name: '   ' })).toEqual({ bio: null, name: null })
  })

  test('a zero is not empty', () => {
    expect(trimAll({ count: 0, off: false })).toEqual({ count: 0, off: false })
  })

  test('it walks nested objects and arrays', () => {
    expect(trimAll({ user: { name: ' Ada ' }, tags: [' a ', ''] })).toEqual({
      user: { name: 'Ada' },
      tags: ['a', null]
    })
  })

  /** A password whose trailing space was trimmed is one nobody can type again. */
  test('a password is left exactly as it arrived', () => {
    expect(trimAll({ password: ' secret ' }, ['password'])).toEqual({ password: ' secret ' })
  })

  test('and at every depth, because a name means the same thing anywhere', () => {
    expect(trimAll({ users: [{ password: ' a ' }] }, ['password'])).toEqual({
      users: [{ password: ' a ' }]
    })
  })

  /** Walking into it would replace the upload with a record of its properties. */
  test('a File is left alone', () => {
    const file = new File(['x'], 'a.txt')

    expect(trimAll({ avatar: file })).toEqual({ avatar: file })
  })

  test('as a plugin, the body a handler sees is already normalised', async () => {
    const app = new Elysia()
      .use(normaliseInputPlugin())
      .post('/', ({ body }) => JSON.stringify(body))

    const answer = await app.handle(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  Ada  ', bio: '' })
      })
    )

    expect(await answer.text()).toBe('{"name":"Ada","bio":null}')
  })
})

describe('precognition', () => {
  const asking = (headers: Record<string, string>) =>
    new Request('http://example.com/', { headers })

  test('reads the headers', () => {
    expect(isPrecognitive(asking({ precognition: 'true' }))).toBe(true)
    expect(isPrecognitive(asking({}))).toBe(false)
    expect(validateOnly(asking({ 'precognition-validate-only': 'email, name' }))).toEqual([
      'email',
      'name'
    ])
    expect(validateOnly(asking({}))).toBeUndefined()
  })

  /** So a half-filled form does not light up red for everything untouched. */
  test('narrows the rules to what was asked about', () => {
    const rules = { email: 'required', name: 'required', age: 'integer' }

    expect(Object.keys(narrowRules(rules, ['email']))).toEqual(['email'])
  })

  test('and a wildcard rule answers for the key it expands to', () => {
    const rules = { 'items.*.price': 'numeric', name: 'required' }

    expect(Object.keys(narrowRules(rules, ['items.0.price']))).toEqual(['items.*.price'])
  })

  class StoreOrder extends FormRequest {
    rules() {
      return { email: 'required|email', quantity: 'required|integer' }
    }
  }

  /** A precognitive POST to "create an order" validates it and creates nothing. */
  test('a passing precognitive request stops before the handler', async () => {
    const run = validateRequest(StoreOrder, {
      request: asking({ precognition: 'true' }),
      body: { email: 'ada@example.com', quantity: 2 }
    } as never)

    await expect(run).rejects.toThrow('Precognitive request validated.')
  })

  test('and answers 204 with the header echoed back', async () => {
    try {
      await validateRequest(StoreOrder, {
        request: asking({ precognition: 'true' }),
        body: { email: 'ada@example.com', quantity: 2 }
      } as never)
    } catch (error) {
      const response = (error as { [CARRIES_RESPONSE](): Response })[CARRIES_RESPONSE]()

      expect(response.status).toBe(204)
      expect(response.headers.get('precognition')).toBe('true')

      return
    }

    throw new Error('the request should not have completed')
  })

  test('an untouched field is not validated', async () => {
    const data = validateRequest(StoreOrder, {
      request: asking({ precognition: 'true', 'precognition-validate-only': 'email' }),
      body: { email: 'ada@example.com' }
    } as never)

    // `quantity` is required and absent, and it was not asked about.
    await expect(data).rejects.toThrow('Precognitive request validated.')
  })

  test('a request that is not precognitive runs as it always did', async () => {
    const data = await validateRequest(StoreOrder, {
      request: asking({}),
      body: { email: 'ada@example.com', quantity: 2 }
    } as never)

    expect(data).toEqual({ email: 'ada@example.com', quantity: 2 })
  })
})

describe('a route lock', () => {
  /** The one-line answer to a double-clicked "Pay" button. */
  test('the second caller waits, and gives up as a 429', async () => {
    const taken = new Set<string>()

    const cache = {
      lock: (name: string) => ({
        block: async (wait: number) => {
          if (taken.has(name)) throw new Error(`timed out after ${wait}s`)

          taken.add(name)

          return true
        },
        release: async () => taken.delete(name)
      })
    }

    const app = new Application(process.cwd())
    app.instance('cache' as never, cache as never)

    const guard = routeLock({ wait: 3 })
    const press = () => guard({ request: new Request('http://example.com/pay') })

    expect(await press()).toBeUndefined()

    await expect(press()).rejects.toThrow(RouteBusyError)
  })

  /** A lock a failed request kept would block the retry that failure invites. */
  test('and it is released afterwards', async () => {
    const taken = new Set<string>()

    const cache = {
      lock: (name: string) => ({
        block: async () => {
          if (taken.has(name)) throw new Error('taken')

          taken.add(name)

          return true
        },
        release: async () => taken.delete(name)
      })
    }

    const app = new Application(process.cwd())
    app.instance('cache' as never, cache as never)

    await withoutRequestContext(async () => {
      enterWorkContext()

      await routeLock()({ request: new Request('http://example.com/pay') })
      await releaseRouteLock()
    })

    expect(taken.size).toBe(0)
  })

  test('without the cache it says what to register', async () => {
    const app = new Application(process.cwd())
    app.forgetInstance('cache' as never)

    await expect(routeLock()({ request: new Request('http://example.com/pay') })).rejects.toThrow(
      'needs the cache'
    )
  })
})
