import { describe, expect, test } from 'bun:test'
import { Broadcaster, type Subscriber } from '../src/broadcaster.ts'
import { ChannelRegistry, matchChannel } from '../src/channels.ts'

const socket = (id: string, user: { id?: unknown } | null = null) => {
  const received: string[] = []

  return {
    subscriber: { id, user, send: (payload: string) => received.push(payload) } as Subscriber,
    received
  }
}

describe('channel patterns', () => {
  test('a parameter is captured', () => {
    expect<unknown>(matchChannel('orders.{id}', 'orders.7')).toEqual({ id: '7' })
  })

  test('a parameter never spans a dot', () => {
    // `orders.7.lines` is a different channel, not order "7.lines".
    expect<unknown>(matchChannel('orders.{id}', 'orders.7.lines')).toBeUndefined()
  })

  test('a literal channel matches itself only', () => {
    expect<unknown>(matchChannel('status', 'status')).toEqual({})
    expect<unknown>(matchChannel('status', 'statuses')).toBeUndefined()
  })
})

describe('who may listen', () => {
  test('an undeclared channel is refused', async () => {
    // Broadcasting a private channel to whoever asks is the failure that ends up
    // in an incident report; refusing an unknown name is the safe default.
    expect<boolean>(await new ChannelRegistry().authorize('orders.7', { id: 1 })).toBe(false)
  })

  test('the authorizer sees the channel parameters', async () => {
    const registry = new ChannelRegistry().channel(
      'orders.{id}',
      (user, { id }) => user?.id === Number(id)
    )

    expect<boolean>(await registry.authorize('orders.7', { id: 7 })).toBe(true)
    expect<boolean>(await registry.authorize('orders.7', { id: 8 })).toBe(false)
    expect<boolean>(await registry.authorize('orders.7', null)).toBe(false)
  })

  test('an authorizer that throws refuses', async () => {
    const registry = new ChannelRegistry().channel('orders.{id}', () => {
      throw new Error('lookup failed')
    })

    // Letting the socket in because the check failed is the wrong way round.
    expect<boolean>(await registry.authorize('orders.7', { id: 7 })).toBe(false)
  })

  test('the first declared pattern decides', async () => {
    const registry = new ChannelRegistry()
      .public('orders.public')
      .channel('orders.{id}', () => false)

    expect<boolean>(await registry.authorize('orders.public', null)).toBe(true)
    expect<boolean>(await registry.authorize('orders.7', null)).toBe(false)
  })
})

describe('fanning an event out', () => {
  test('only subscribed sockets receive it', async () => {
    const broadcaster = new Broadcaster(new ChannelRegistry().public('orders.7'))
    const listening = socket('a')
    const elsewhere = socket('b')

    expect<boolean>(await broadcaster.subscribe(listening.subscriber, 'orders.7')).toBe(true)

    const sent = broadcaster.broadcast({
      channel: 'orders.7',
      event: 'updated',
      payload: { total: 9 }
    })

    expect<number>(sent).toBe(1)
    expect<unknown>(JSON.parse(listening.received[0] as string)).toEqual({
      channel: 'orders.7',
      event: 'updated',
      payload: { total: 9 }
    })
    expect<number>(elsewhere.received.length).toBe(0)
  })

  test('a refused subscription receives nothing', async () => {
    const broadcaster = new Broadcaster(new ChannelRegistry())
    const denied = socket('a')

    expect<boolean>(await broadcaster.subscribe(denied.subscriber, 'orders.7')).toBe(false)
    expect<number>(broadcaster.broadcast({ channel: 'orders.7', event: 'x', payload: null })).toBe(
      0
    )
  })

  test('the socket that caused the event can be skipped', async () => {
    const broadcaster = new Broadcaster(new ChannelRegistry().public('orders.7'))
    const author = socket('author')
    const other = socket('other')

    await broadcaster.subscribe(author.subscriber, 'orders.7')
    await broadcaster.subscribe(other.subscriber, 'orders.7')

    // Without this the client that just posted renders its own message twice.
    broadcaster.broadcast({ channel: 'orders.7', event: 'x', payload: null }, 'author')

    expect<number>(author.received.length).toBe(0)
    expect<number>(other.received.length).toBe(1)
  })

  test('a disconnect drops the socket from every channel', async () => {
    const broadcaster = new Broadcaster(new ChannelRegistry().public('a').public('b'))
    const gone = socket('gone')

    await broadcaster.subscribe(gone.subscriber, 'a')
    await broadcaster.subscribe(gone.subscriber, 'b')

    broadcaster.forget(gone.subscriber)

    expect<number>(broadcaster.count('a')).toBe(0)
    expect<number>(broadcaster.count('b')).toBe(0)
  })

  test('a socket that cannot be written to is dropped', async () => {
    const broadcaster = new Broadcaster(new ChannelRegistry().public('orders.7'))

    const broken: Subscriber = {
      id: 'broken',
      user: null,
      send: () => {
        throw new Error('socket closed')
      }
    }

    await broadcaster.subscribe(broken, 'orders.7')
    broadcaster.broadcast({ channel: 'orders.7', event: 'x', payload: null })

    // Otherwise a dead connection is retried on every future broadcast.
    expect<number>(broadcaster.count('orders.7')).toBe(0)
  })
})
