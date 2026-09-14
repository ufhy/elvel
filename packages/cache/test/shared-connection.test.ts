import { describe, expect, test } from 'bun:test'
import { RedisStore, type SharedRedisConnection } from '../src/stores/redis.ts'

/**
 * The store used to open a client of its own from its own URL, so an
 * application whose cache, queue and broadcaster all pointed at one server held
 * four connections and named it three times. When something supplies a
 * connection the store uses it; when nothing does, nothing changes.
 */
function shared(seen: Array<[string, unknown[]]>, prefix = ''): SharedRedisConnection {
  const client = new Proxy(
    {},
    {
      get:
        (_target, property) =>
        (...args: unknown[]) => {
          seen.push([String(property), args])

          return Promise.resolve(null)
        }
    }
  ) as never

  return { client, subscriber: () => client, prefix: () => prefix }
}

describe('a supplied connection', () => {
  test('is what the store issues commands on', async () => {
    const seen: Array<[string, unknown[]]> = []

    await new RedisStore({ connection: shared(seen), prefix: 'cache:' }).get('users:1')

    expect<Array<[string, unknown[]]>>(seen).toEqual([['get', ['cache:users:1']]])
  })

  test("and its prefix sits in front of the store's own", () => {
    expect<string>(
      new RedisStore({ connection: shared([], 'app:'), prefix: 'cache:' }).prefix
    ).toBe('app:cache:')
  })
})
