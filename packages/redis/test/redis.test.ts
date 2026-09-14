import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { CommandExecuted, CommandFailed, RedisConnection } from '../src/connection.ts'
import { RedisManager } from '../src/manager.ts'
import { RedisServiceProvider } from '../src/provider.ts'

/**
 * A client that answers without a server.
 *
 * Every test here is about what the manager and the connection decide — which
 * client a key lands on, whether a name is memoised, what is dispatched — and
 * none of it needs Redis to be running.
 */
function fakeClient(answer: unknown = 'OK') {
  const seen: Array<[string, string[]]> = []

  return {
    seen,
    client: {
      send: (command: string, args: string[]) => {
        seen.push([command, args])

        if (answer instanceof Error) throw answer

        return Promise.resolve(answer)
      },
      close: () => {}
    } as never
  }
}

function application(config: Record<string, unknown> = {}): Application {
  const app = new Application(import.meta.dir)

  app.config.set('redis', config)

  return app
}

describe('named connections', () => {
  test('one name is one connection', () => {
    const manager = new RedisManager(
      application({ connections: { default: { url: 'redis://127.0.0.1:6379' } } })
    )

    expect<boolean>(manager.connection() === manager.connection('default')).toBe(true)
  })

  test('two names are two connections', () => {
    const manager = new RedisManager(
      application({
        connections: {
          default: { url: 'redis://127.0.0.1:6379' },
          cache: { url: 'redis://x:6379' }
        }
      })
    )

    expect<boolean>(manager.connection('cache') === manager.connection('default')).toBe(false)
  })

  test('the default is configurable', () => {
    const manager = new RedisManager(
      application({ default: 'cache', connections: { cache: { url: 'redis://x:6379' } } })
    )

    expect<string>(manager.connection().name).toBe('cache')
  })

  /** A typo would otherwise open a connection to localhost and fail far away. */
  test('an unconfigured name is an error, not a default', () => {
    const manager = new RedisManager(application({ connections: {} }))

    expect(() => manager.connection('sessions')).toThrow('Redis connection [sessions]')
  })

  test('names lists what is configured', () => {
    const manager = new RedisManager(
      application({ connections: { default: {}, cache: {}, cluster: {} } })
    )

    expect<string[]>(manager.names()).toEqual(['default', 'cache', 'cluster'])
  })

  test('a connection can be supplied, for a test or a second server', () => {
    const manager = new RedisManager(application({ connections: { default: {} } }))
    const supplied = new RedisConnection('default')

    manager.set('default', supplied)

    expect<boolean>(manager.connection() === supplied).toBe(true)
  })
})

describe('commands', () => {
  test('are dispatched with their timing when somebody is listening', async () => {
    const dispatched: unknown[] = []
    const connection = new RedisConnection('default', {}, { dispatch: (e) => dispatched.push(e) })
    const fake = fakeClient('PONG')

    connection.clientFor = () => fake.client

    expect<unknown>(await connection.send('GET', ['users:1'])).toBe('PONG')
    expect<Array<[string, string[]]>>(fake.seen).toEqual([['GET', ['users:1']]])

    const event = dispatched[0] as CommandExecuted

    expect<boolean>(event instanceof CommandExecuted).toBe(true)
    expect<string>(event.command).toBe('GET')
    expect<string>(event.connectionName).toBe('default')
    expect<boolean>(event.duration >= 0).toBe(true)
  })

  /** A worker polling every few milliseconds should allocate nothing. */
  test('and nothing is built when nobody is', async () => {
    const connection = new RedisConnection('default', {}, undefined)
    const fake = fakeClient()

    connection.clientFor = () => fake.client

    await connection.send('PING')

    expect<Array<[string, string[]]>>(fake.seen).toEqual([['PING', []]])
  })

  test('a failure is dispatched and still thrown', async () => {
    const dispatched: unknown[] = []
    const connection = new RedisConnection('default', {}, { dispatch: (e) => dispatched.push(e) })
    const fake = fakeClient(new Error('connection refused'))

    connection.clientFor = () => fake.client

    expect(connection.send('GET', ['k'])).rejects.toThrow('connection refused')

    await Bun.sleep(0)

    expect<boolean>(dispatched.some((event) => event instanceof CommandFailed)).toBe(true)
  })
})

describe('several nodes', () => {
  test('a key lands on the same node every time', () => {
    const connection = new RedisConnection('cluster', {
      nodes: ['redis://a:6379', 'redis://b:6379', 'redis://c:6379']
    })

    const first = connection.clientFor('users:1')

    expect<boolean>(connection.clientFor('users:1') === first).toBe(true)
  })

  test('and the keys are spread across them', () => {
    const connection = new RedisConnection('cluster', {
      nodes: ['redis://a:6379', 'redis://b:6379', 'redis://c:6379']
    })

    const used = new Set(
      Array.from({ length: 60 }, (_, index) => connection.clientFor(`users:${index}`))
    )

    expect<number>(used.size).toBe(3)
  })

  test('one node is always the answer', () => {
    const connection = new RedisConnection('default', { url: 'redis://a:6379' })

    expect<boolean>(connection.clientFor('anything') === connection.client).toBe(true)
  })
})

describe('the provider', () => {
  test('binds one manager', async () => {
    const app = application({ connections: { default: {} } })

    await app.register(RedisServiceProvider)

    expect<boolean>(app.bound('redis')).toBe(true)

    const resolved = app.make('redis')

    expect<boolean>(app.make('redis') === resolved).toBe(true)
  })
})

/**
 * The cache, the queue and the broadcaster call `get`, `set` and `send` on the
 * client itself, so timing only `RedisConnection.send` would have left the
 * commands an application actually issues invisible.
 */
describe('the shared client', () => {
  test('times the commands the other packages issue', async () => {
    const dispatched: CommandExecuted[] = []
    const connection = new RedisConnection(
      'default',
      {},
      {
        dispatch: (event) => dispatched.push(event as CommandExecuted)
      }
    )
    const fake = fakeClient('cached')

    Object.defineProperty(connection, 'clients', { value: [fake.client] })

    expect<unknown>(await connection.client.send('GET', ['users:1'])).toBe('cached')

    expect<string[]>(dispatched.map((event) => event.command)).toEqual(['GET'])
    expect<string[]>(dispatched[0]?.args ?? []).toEqual(['users:1'])
  })

  test('and is the client itself when nothing is listening', () => {
    const connection = new RedisConnection('default', { url: 'redis://a:6379' })

    expect<boolean>(connection.client === connection.clientFor()).toBe(true)
  })

  test('closing is not a command', async () => {
    const dispatched: unknown[] = []
    const connection = new RedisConnection('default', {}, { dispatch: (e) => dispatched.push(e) })
    const fake = fakeClient()

    Object.defineProperty(connection, 'clients', { value: [fake.client] })
    connection.client.close()

    expect<number>(dispatched.length).toBe(0)
  })
})
