import { describe, expect, test } from 'bun:test'
import { Echo, type WebSocketLike } from '../src/client.ts'

/** A socket a test can drive: what it was sent, and what it delivers. */
function fakeSocket() {
  const sent: string[] = []
  const sockets: Socket[] = []

  class Socket implements WebSocketLike {
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onclose: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null

    send(data: string): void {
      sent.push(data)
    }

    close(): void {
      this.onclose?.({})
    }

    /** Pretend the server said this. */
    deliver(frame: unknown): void {
      this.onmessage?.({ data: JSON.stringify(frame) })
    }
  }

  return {
    sent,
    sockets,
    open: (_url: string) => {
      const socket = new Socket()
      sockets.push(socket)

      return socket
    }
  }
}

const settings = (open: (url: string) => WebSocketLike) => ({ socket: open, delay: 1, maxDelay: 1 })

describe('the socket id', () => {
  /** The whole of toOthers() from the client's side. */
  test('is learned from the connect frame', () => {
    const { open, sockets } = fakeSocket()
    const echo = new Echo(settings(open))

    expect(echo.socketId()).toBeUndefined()

    sockets[0]?.deliver({ event: 'connected', socketId: 'abc' })

    expect(echo.socketId()).toBe('abc')
    expect(echo.connected()).toBe(true)
  })
})

describe('channels', () => {
  test('subscribing sends a frame, and the same channel is handed back', () => {
    const { open, sent } = fakeSocket()
    const echo = new Echo(settings(open))

    const first = echo.channel('orders.7')
    const again = echo.channel('orders.7')

    expect(first).toBe(again)
    expect(sent).toEqual(['{"subscribe":"orders.7"}'])
  })

  test('an event reaches its listener, and a wildcard hears everything', () => {
    const { open, sockets } = fakeSocket()
    const echo = new Echo(settings(open))
    const seen: string[] = []

    echo.channel('orders.7').listen('OrderShipped', () => seen.push('specific'))
    echo.channel('orders.7').listen('*', (_payload, event) => seen.push(`any:${event}`))

    sockets[0]?.deliver({ channel: 'orders.7', event: 'OrderShipped', payload: { id: 7 } })

    expect(seen).toEqual(['specific', 'any:OrderShipped'])
  })

  test('stopListening removes one', () => {
    const { open, sockets } = fakeSocket()
    const echo = new Echo(settings(open))
    const seen: string[] = []
    const handler = () => seen.push('heard')

    const channel = echo.channel('orders.7').listen('OrderShipped', handler)
    channel.stopListening('OrderShipped', handler)

    sockets[0]?.deliver({ channel: 'orders.7', event: 'OrderShipped', payload: {} })

    expect(seen).toEqual([])
  })

  test('leaving unsubscribes and forgets it', () => {
    const { open, sent } = fakeSocket()
    const echo = new Echo(settings(open))

    echo.channel('orders.7')
    echo.leave('orders.7')

    expect(sent).toContain('{"unsubscribe":"orders.7"}')
  })
})

/** A socket back with no subscriptions looks exactly like a quiet channel. */
describe('reconnecting', () => {
  test('resubscribes everything it held', async () => {
    const { open, sent, sockets } = fakeSocket()
    const echo = new Echo(settings(open))

    echo.channel('orders.7')
    echo.channel('invoices')

    sent.length = 0
    sockets[0]?.close()

    await Bun.sleep(20)

    sockets[1]?.onopen?.({})

    expect(sent).toEqual(['{"subscribe":"orders.7"}', '{"subscribe":"invoices"}'])
    expect(echo.socketId()).toBeUndefined()
  })

  test('and gives up after maxAttempts', async () => {
    const { open, sockets } = fakeSocket()

    new Echo({ socket: open, delay: 1, maxDelay: 1, maxAttempts: 1 })

    sockets[0]?.close()
    await Bun.sleep(20)

    sockets[1]?.close()
    await Bun.sleep(20)

    expect(sockets).toHaveLength(2)
  })

  test('disconnect stops it reconnecting at all', async () => {
    const { open, sockets } = fakeSocket()
    const echo = new Echo(settings(open))

    echo.disconnect()
    await Bun.sleep(20)

    expect(sockets).toHaveLength(1)
  })
})

/** Every application reduced three events back into a list, and got it wrong. */
describe('presence is a list', () => {
  test('here, joined and left move the members', () => {
    const { open, sockets } = fakeSocket()
    const echo = new Echo(settings(open))
    const channel = echo.channel('room.1')

    sockets[0]?.deliver({
      channel: 'room.1',
      event: 'presence.here',
      payload: { members: [{ id: 1 }, { id: 2 }] }
    })

    expect(channel.members.map((one) => one.id)).toEqual([1, 2])

    sockets[0]?.deliver({
      channel: 'room.1',
      event: 'presence.joined',
      payload: { member: { id: 3 } }
    })

    expect(channel.members.map((one) => one.id)).toEqual([1, 2, 3])

    sockets[0]?.deliver({
      channel: 'room.1',
      event: 'presence.left',
      payload: { member: { id: 2 } }
    })

    expect(channel.members.map((one) => one.id)).toEqual([1, 3])
  })

  /** A second tab is not a second arrival. */
  test('and joining twice is one member', () => {
    const { open, sockets } = fakeSocket()
    const channel = new Echo(settings(open)).channel('room.1')

    sockets[0]?.deliver({
      channel: 'room.1',
      event: 'presence.joined',
      payload: { member: { id: 1 } }
    })
    sockets[0]?.deliver({
      channel: 'room.1',
      event: 'presence.joined',
      payload: { member: { id: 1 } }
    })

    expect(channel.members).toHaveLength(1)
  })
})

describe('bad frames', () => {
  test('are ignored rather than throwing', () => {
    const { open, sockets } = fakeSocket()
    const echo = new Echo(settings(open))

    echo.channel('orders.7')

    expect(() => sockets[0]?.onmessage?.({ data: 'not json' })).not.toThrow()
    expect(() => sockets[0]?.deliver({ channel: 'unknown', event: 'x' })).not.toThrow()
  })
})
