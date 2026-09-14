import { describe, expect, test } from 'bun:test'
import { RedisQueue, type SharedRedisConnection } from '../src/drivers/redis.ts'

/**
 * The driver opened its own client, and a second one for the blocking read. A
 * supplied connection covers the first; the waiter still gets one of its own,
 * because `BLPOP` holds the connection it runs on and sharing it would stall
 * every push issued from the same process.
 */
function shared(
  seen: Array<[string, unknown[]]>,
  subscribers: number[],
  prefix = ''
): SharedRedisConnection {
  const client = new Proxy(
    {},
    {
      get:
        (_target, property) =>
        (...args: unknown[]) => {
          seen.push([String(property), args])

          return Promise.resolve(0)
        }
    }
  ) as never

  return {
    client,
    subscriber: () => {
      subscribers.push(1)

      return client
    },
    prefix: () => prefix
  }
}

describe('a supplied connection', () => {
  test('is what the driver issues commands on', async () => {
    const seen: Array<[string, unknown[]]> = []

    await new RedisQueue('redis', { connection: shared(seen, []) }).size()

    expect<string[]>(seen.map(([, args]) => String((args[1] as string[])[0]))).toEqual([
      'queues:default',
      'queues:default:delayed',
      'queues:default:reserved'
    ])
  })

  test("and its prefix sits in front of the driver's own", async () => {
    const seen: Array<[string, unknown[]]> = []

    await new RedisQueue('redis', { connection: shared(seen, [], 'app:') }).size()

    expect<string>(String((seen[0]?.[1]?.[1] as string[])[0])).toBe('app:queues:default')
  })
})
