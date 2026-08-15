import { describe, expect, test } from 'bun:test'
import { RedisClient } from 'bun'
import { Broadcaster, type Subscriber } from '../src/broadcaster.ts'
import { ChannelRegistry, matchChannel } from '../src/channels.ts'
import { RedisPubSub } from '../src/redis.ts'

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

describe('presence channels', () => {
  const registry = () =>
    new ChannelRegistry().presence('room.{id}', (user) =>
      user ? { id: user.id, name: `user-${String(user.id)}` } : null
    )

  /** Every frame this socket received, parsed. */
  const frames = (received: string[]) =>
    received.map((raw) => JSON.parse(raw) as { event: string; payload: Record<string, unknown> })

  test('a joiner is told who is here, including itself', async () => {
    const broadcaster = new Broadcaster(registry())
    const ada = socket('a', { id: 1 })
    const linus = socket('b', { id: 2 })

    await broadcaster.subscribe(ada.subscriber, 'room.7')
    await broadcaster.subscribe(linus.subscriber, 'room.7')

    const adaFrames = frames(ada.received)
    const linusFrames = frames(linus.received)

    // Echo's contract: the list is everybody on the channel, the joiner
    // included, and the joiner does not also receive its own arrival.
    expect<unknown>(adaFrames[0]).toMatchObject({
      event: 'presence.here',
      payload: { members: [{ id: 1, name: 'user-1' }] }
    })
    expect<unknown>(linusFrames[0]?.payload.members).toEqual([
      { id: 1, name: 'user-1' },
      { id: 2, name: 'user-2' }
    ])
    expect<unknown>(linusFrames.map((frame) => frame.event)).toEqual(['presence.here'])
  })

  test('the others hear a join and a leave', async () => {
    const broadcaster = new Broadcaster(registry())
    const ada = socket('a', { id: 1 })
    const linus = socket('b', { id: 2 })

    await broadcaster.subscribe(ada.subscriber, 'room.7')
    await broadcaster.subscribe(linus.subscriber, 'room.7')

    expect<unknown>(frames(ada.received).map((frame) => frame.event)).toEqual([
      'presence.here',
      'presence.joined'
    ])

    broadcaster.unsubscribe(linus.subscriber, 'room.7')

    const last = frames(ada.received).at(-1)

    expect<unknown>(last).toMatchObject({
      event: 'presence.left',
      payload: { member: { id: 2, name: 'user-2' } }
    })
  })

  test('two tabs are one member, and one arrival', async () => {
    const broadcaster = new Broadcaster(registry())
    const ada = socket('a', { id: 1 })
    const sameAda = socket('a2', { id: 1 })
    const watcher = socket('w', { id: 9 })

    await broadcaster.subscribe(watcher.subscriber, 'room.7')
    await broadcaster.subscribe(ada.subscriber, 'room.7')
    await broadcaster.subscribe(sameAda.subscriber, 'room.7')

    expect<unknown>(broadcaster.presence('room.7')).toEqual([
      { id: 9, name: 'user-9' },
      { id: 1, name: 'user-1' }
    ])

    // The watcher is on the list it was sent, and heard Ada arrive once.

    // One `joined` for Ada, not two: the second tab is not a second person.
    expect<number>(
      frames(watcher.received).filter((frame) => frame.event === 'presence.joined').length
    ).toBe(1)

    // And closing one tab says nothing, because she is still here.
    broadcaster.unsubscribe(ada.subscriber, 'room.7')

    expect<number>(
      frames(watcher.received).filter((frame) => frame.event === 'presence.left').length
    ).toBe(0)

    broadcaster.unsubscribe(sameAda.subscriber, 'room.7')

    expect<number>(
      frames(watcher.received).filter((frame) => frame.event === 'presence.left').length
    ).toBe(1)
  })

  test('a refused member is not on the list and hears nothing', async () => {
    const broadcaster = new Broadcaster(registry())
    const guest = socket('g', null)

    expect<boolean>(await broadcaster.subscribe(guest.subscriber, 'room.7')).toBe(false)
    expect<unknown>(broadcaster.presence('room.7')).toEqual([])
    expect<number>(guest.received.length).toBe(0)
  })

  test('an ordinary channel tracks nobody', async () => {
    const broadcaster = new Broadcaster(new ChannelRegistry().public('orders.7'))
    const ada = socket('a', { id: 1 })

    await broadcaster.subscribe(ada.subscriber, 'orders.7')

    // No `here` frame either: a client that is not on a presence channel is not
    // waiting for one.
    expect<unknown>(broadcaster.presence('orders.7')).toEqual([])
    expect<number>(ada.received.length).toBe(0)
  })

  test('disconnecting announces the leave on every channel', async () => {
    const broadcaster = new Broadcaster(
      new ChannelRegistry().presence('room.{id}', (user) => (user ? { id: user.id } : null))
    )
    const ada = socket('a', { id: 1 })
    const watcher = socket('w', { id: 9 })

    await broadcaster.subscribe(watcher.subscriber, 'room.7')
    await broadcaster.subscribe(ada.subscriber, 'room.7')

    broadcaster.forget(ada.subscriber)

    expect<unknown>(frames(watcher.received).at(-1)).toMatchObject({
      event: 'presence.left',
      payload: { member: { id: 1 } }
    })
    expect<unknown>(broadcaster.presence('room.7')).toEqual([{ id: 9 }])
  })
})

/**
 * Two processes, which is the case the whole thing exists for.
 *
 * A load balancer puts half the sockets on one process and half on another, and
 * an in-memory broadcaster reaches only its own half. Two `Broadcaster`
 * instances sharing a Redis bus is that situation, minus the second process.
 *
 * Against a real Redis — a fake bus would prove the wiring and nothing about
 * the part that actually fails, which is the round trip.
 */
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'

const redisAvailable = await (async () => {
  try {
    const probe = new RedisClient(REDIS_URL)
    await probe.set('elysian:broadcast:probe', '1')
    probe.close()

    return true
  } catch {
    console.log(`  skipping the cross-process tests: no Redis at ${REDIS_URL}`)

    return false
  }
})()

describe.if(redisAvailable)('across processes, over Redis', () => {
  const prefix = `t${Date.now().toString(36)}:`

  /** One "process": its own broadcaster, its own pair of Redis connections. */
  const node = () => {
    const bus = new RedisPubSub({ url: REDIS_URL, prefix })
    const broadcaster = new Broadcaster(new ChannelRegistry().public('orders.7'), bus)

    return { bus, broadcaster }
  }

  /** Subscriptions are asynchronous; this is what waits for the round trip. */
  const settle = () => Bun.sleep(80)

  test('an event reaches sockets held by another process', async () => {
    const first = node()
    const second = node()
    await settle()

    const here = socket('here')
    const there = socket('there')

    await first.broadcaster.subscribe(here.subscriber, 'orders.7')
    await second.broadcaster.subscribe(there.subscriber, 'orders.7')

    first.broadcaster.broadcast({ channel: 'orders.7', event: 'shipped', payload: { id: 7 } })
    await settle()

    try {
      // The point: the socket on the *other* process heard it.
      expect<number>(there.received.length).toBe(1)
      expect<unknown>(JSON.parse(there.received[0] as string)).toMatchObject({
        channel: 'orders.7',
        event: 'shipped'
      })

      // And the publisher's own socket heard it exactly once — it is served by
      // the message coming back, not by a local delivery before publishing.
      expect<number>(here.received.length).toBe(1)
    } finally {
      first.bus.close()
      second.bus.close()
    }
  })

  test('the excluded socket is excluded wherever it lives', async () => {
    const first = node()
    const second = node()
    await settle()

    const author = socket('author')
    const reader = socket('reader')

    await first.broadcaster.subscribe(author.subscriber, 'orders.7')
    await second.broadcaster.subscribe(reader.subscriber, 'orders.7')

    // `toOthers()`: the socket that caused the event does not hear its own echo.
    first.broadcaster.broadcast(
      { channel: 'orders.7', event: 'commented', payload: null },
      'author'
    )
    await settle()

    try {
      expect<number>(author.received.length).toBe(0)
      // The other process has no socket with that id, which is the right answer
      // there rather than something to resolve before publishing.
      expect<number>(reader.received.length).toBe(1)
    } finally {
      first.bus.close()
      second.bus.close()
    }
  })

  test('a process with no sockets on the channel simply drops it', async () => {
    const first = node()
    const second = node()
    await settle()

    const only = socket('only')
    await first.broadcaster.subscribe(only.subscriber, 'orders.7')

    second.broadcaster.broadcast({ channel: 'orders.7', event: 'shipped', payload: null })
    await settle()

    try {
      expect<number>(only.received.length).toBe(1)
      expect<number>(second.broadcaster.count('orders.7')).toBe(0)
    } finally {
      first.bus.close()
      second.bus.close()
    }
  })

  test('a prefix keeps two applications on one Redis apart', async () => {
    const mine = node()
    const theirs = {
      bus: new RedisPubSub({ url: REDIS_URL, prefix: `${prefix}other:` }),
      broadcaster: new Broadcaster(new ChannelRegistry().public('orders.7'))
    }

    const listener = socket('listener')
    await theirs.broadcaster.subscribe(listener.subscriber, 'orders.7')
    await settle()

    mine.broadcaster.broadcast({ channel: 'orders.7', event: 'shipped', payload: null })
    await settle()

    try {
      expect<number>(listener.received.length).toBe(0)
    } finally {
      mine.bus.close()
      theirs.bus.close()
    }
  })

  test('with no bus at all, nothing changes', async () => {
    // The single-process case stays exactly as it was: delivered here, counted
    // here, no Redis involved.
    const alone = new Broadcaster(new ChannelRegistry().public('orders.7'))
    const listener = socket('listener')

    await alone.subscribe(listener.subscriber, 'orders.7')

    expect<number>(alone.broadcast({ channel: 'orders.7', event: 'x', payload: null })).toBe(1)
    expect<number>(listener.received.length).toBe(1)
  })
})
