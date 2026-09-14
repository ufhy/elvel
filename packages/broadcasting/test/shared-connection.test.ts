import { describe, expect, test } from 'bun:test'
import { RedisPubSub, type SharedRedisConnection } from '../src/redis.ts'

/**
 * Broadcasting needs two clients — one in subscribe mode may issue nothing else
 * — so it was the largest share of the connections an application held. With a
 * supplied connection both come from it, and neither is a second URL to keep in
 * step with the first.
 */
function shared(seen: Array<[string, unknown[]]>): SharedRedisConnection {
  const client = new Proxy(
    {},
    {
      get:
        (_target, property) =>
        (...args: unknown[]) => {
          seen.push([String(property), args])

          return Promise.resolve(1)
        }
    }
  ) as never

  return { client, subscriber: () => client, prefix: () => 'app:' }
}

describe('a supplied connection', () => {
  test('publishes on it, under its prefix', async () => {
    const seen: Array<[string, unknown[]]> = []

    await new RedisPubSub({ connection: shared(seen) }).publish({
      channel: 'orders',
      event: 'shipped',
      payload: {}
    } as never)

    expect<string>(String(seen[0]?.[0])).toBe('publish')
    expect<string>(String(seen[0]?.[1]?.[0])).toBe('app:broadcast')
  })
})
