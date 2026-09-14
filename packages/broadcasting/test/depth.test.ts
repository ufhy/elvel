import { describe, expect, test } from 'bun:test'
import { enterWorkContext, withoutRequestContext } from '@elvel/core'
import { Broadcaster } from '../src/broadcaster.ts'
import { ChannelRegistry } from '../src/channels.ts'
import { LogPubSub, NullPubSub } from '../src/drivers.ts'
import { currentSocket, enterSocket, withSocket } from '../src/socket.ts'

function inRequest<T>(body: () => T): T {
  return withoutRequestContext(() => {
    enterWorkContext()

    return body()
  })
}

/** The first bug everybody writes: the tab that posted renders its own event twice. */
describe('the socket that caused the request', () => {
  test('is remembered for the request', () => {
    inRequest(() => {
      enterSocket('socket-1')

      expect(currentSocket()).toBe('socket-1')
    })
  })

  test('and does not leak into the next one', () => {
    inRequest(() => enterSocket('socket-1'))

    expect(inRequest(currentSocket)).toBeUndefined()
  })

  test('withSocket scopes it to a body', () => {
    inRequest(() => {
      withSocket('socket-2', () => {
        expect(currentSocket()).toBe('socket-2')
      })

      expect(currentSocket()).toBeUndefined()
    })
  })
})

describe('the log driver', () => {
  test('prints the frame whole', async () => {
    const lines: string[] = []
    const bus = new LogPubSub((line) => lines.push(line))

    await bus.publish({
      kind: 'broadcast',
      message: { channel: 'orders', event: 'Shipped', payload: { id: 7 } }
    })

    expect(lines[0]).toContain('orders')
    expect(lines[0]).toContain('Shipped')
  })

  /** Nothing is listening; a gather that believed otherwise would wait for nobody. */
  test('and reports no subscribers', async () => {
    const bus = new LogPubSub(() => undefined)

    expect(
      await bus.publish({ kind: 'broadcast', message: { channel: 'a', event: 'b', payload: {} } })
    ).toBe(0)
  })
})

describe('the null driver', () => {
  test('sends nowhere', async () => {
    const bus = new NullPubSub()

    expect(
      await bus.publish({ kind: 'broadcast', message: { channel: 'a', event: 'b', payload: {} } })
    ).toBe(0)
  })
})

/** It was voided: a bus that stopped answering lost broadcasts and said nothing. */
describe('a publish that fails', () => {
  test('is reported rather than swallowed', async () => {
    const failures: unknown[] = []

    const broadcaster = new Broadcaster(new ChannelRegistry(), {
      publish: async () => {
        throw new Error('bus is down')
      },
      onMessage: () => undefined,
      close: () => undefined
    })

    broadcaster.onPublishFailed = (_message, error) => failures.push(error)

    broadcaster.broadcast({ channel: 'orders', event: 'Shipped', payload: {} })

    await Bun.sleep(1)

    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe('bus is down')
  })
})
