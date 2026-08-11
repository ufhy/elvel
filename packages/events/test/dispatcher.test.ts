import { beforeEach, describe, expect, test } from 'bun:test'
import { Dispatcher, eventName } from '../src/dispatcher.ts'
import { EventFake, NullDispatcher } from '../src/fake.ts'

class OrderShipped {
  static readonly eventName = 'order.shipped'

  constructor(readonly orderId: number) {}
}

class PlainEvent {
  constructor(readonly value: string) {}
}

let dispatcher: Dispatcher

beforeEach(() => {
  dispatcher = new Dispatcher()
})

describe('eventName', () => {
  test('a string is its own name', () => {
    expect(eventName('user.created')).toBe('user.created')
  })

  test('a static eventName wins over the class name', () => {
    expect(eventName(OrderShipped)).toBe('order.shipped')
    expect(eventName(new OrderShipped(1))).toBe('order.shipped')
  })

  test('falls back to the class name', () => {
    expect(eventName(PlainEvent)).toBe('PlainEvent')
    expect(eventName(new PlainEvent('x'))).toBe('PlainEvent')
  })

  test("an instance's own `name` field never becomes the event name", () => {
    class Named {
      readonly name = 'not-the-event-name'
    }

    expect(eventName(new Named())).toBe('Named')
  })
})

describe('class events', () => {
  test('the instance is the payload', async () => {
    const seen: number[] = []
    dispatcher.listen(OrderShipped, (event) => {
      seen.push(event.orderId)
    })

    await dispatcher.dispatch(new OrderShipped(7))

    expect(seen).toEqual([7])
  })

  test('listeners run in registration order and their responses are collected', async () => {
    dispatcher.listen(OrderShipped, () => 'first')
    dispatcher.listen(OrderShipped, () => 'second')

    expect(await dispatcher.dispatch(new OrderShipped(1))).toEqual(['first', 'second'])
  })

  test('async listeners are awaited', async () => {
    dispatcher.listen(OrderShipped, async () => {
      await Promise.resolve()
      return 'done'
    })

    expect(await dispatcher.dispatch(new OrderShipped(1))).toEqual(['done'])
  })

  test('dispatching with no listeners yields an empty array', async () => {
    expect(await dispatcher.dispatch(new OrderShipped(1))).toEqual([])
  })
})

describe('string events', () => {
  test('the payload is passed through', async () => {
    const seen: unknown[] = []
    dispatcher.listen('cache.cleared', (payload) => {
      seen.push(payload)
    })

    await dispatcher.dispatch('cache.cleared', { store: 'redis' })

    expect(seen).toEqual([{ store: 'redis' }])
  })

  test('an array of names registers one listener for each', async () => {
    const seen: string[] = []
    dispatcher.listen(['a', 'b'], () => {
      seen.push('called')
    })

    await dispatcher.dispatch('a')
    await dispatcher.dispatch('b')

    expect(seen).toHaveLength(2)
  })
})

describe('wildcards', () => {
  test('a pattern receives the resolved name and the payload', async () => {
    const seen: Array<[string, unknown]> = []
    dispatcher.listen('order.*', (name: string, payload: unknown) => {
      seen.push([name, payload])
    })

    await dispatcher.dispatch('order.created', { id: 1 })
    await dispatcher.dispatch(new OrderShipped(2))
    await dispatcher.dispatch('user.created')

    expect(seen).toEqual([
      ['order.created', { id: 1 }],
      ['order.shipped', expect.any(OrderShipped)]
    ])
  })

  test('a bare * matches everything', async () => {
    let count = 0
    dispatcher.listen('*', () => {
      count += 1
    })

    await dispatcher.dispatch('anything')
    await dispatcher.dispatch('order.shipped')

    expect(count).toBe(2)
  })

  test('dots in a pattern are literal, not regex wildcards', async () => {
    let count = 0
    dispatcher.listen('order.shipped', () => {
      count += 1
    })

    await dispatcher.dispatch('orderXshipped')

    expect(count).toBe(0)
  })

  test('registering a new pattern invalidates the match cache', async () => {
    const seen: string[] = []

    dispatcher.listen('order.*', () => {
      seen.push('first')
    })
    await dispatcher.dispatch('order.created')

    dispatcher.listen('order.cr*', () => {
      seen.push('second')
    })
    await dispatcher.dispatch('order.created')

    expect(seen).toEqual(['first', 'first', 'second'])
  })

  test('direct listeners run before wildcard ones', async () => {
    const order: string[] = []
    dispatcher.listen('order.*', () => {
      order.push('wildcard')
    })
    dispatcher.listen('order.created', () => {
      order.push('direct')
    })

    await dispatcher.dispatch('order.created')

    expect(order).toEqual(['direct', 'wildcard'])
  })
})

describe('propagation', () => {
  test('returning false stops later listeners', async () => {
    const order: string[] = []

    dispatcher.listen('probe', () => {
      order.push('first')
      return false
    })
    dispatcher.listen('probe', () => {
      order.push('second')
    })

    const responses = await dispatcher.dispatch('probe')

    expect(order).toEqual(['first'])
    // The `false` itself is not collected — propagation simply ends.
    expect(responses).toEqual([])
  })

  test('until returns the first non-null response and stops', async () => {
    const order: string[] = []

    dispatcher.listen('probe', () => {
      order.push('first')
      return null
    })
    dispatcher.listen('probe', () => {
      order.push('second')
      return 'answer'
    })
    dispatcher.listen('probe', () => {
      order.push('third')
      return 'ignored'
    })

    expect(await dispatcher.until('probe')).toBe('answer')
    expect(order).toEqual(['first', 'second'])
  })

  test('until returns null when nothing responds', async () => {
    dispatcher.listen('probe', () => undefined)

    expect(await dispatcher.until('probe')).toBeNull()
  })

  test('undefined is treated as no response, not as an answer', async () => {
    dispatcher.listen('probe', () => undefined)
    dispatcher.listen('probe', () => 'answer')

    expect(await dispatcher.until('probe')).toBe('answer')
  })
})

describe('registry', () => {
  test('hasListeners covers direct and wildcard registrations', () => {
    expect(dispatcher.hasListeners('order.created')).toBe(false)

    dispatcher.listen('order.*', () => {})
    expect(dispatcher.hasListeners('order.created')).toBe(true)
    expect(dispatcher.hasListeners('user.created')).toBe(false)

    dispatcher.listen(OrderShipped, () => {})
    expect(dispatcher.hasListeners(OrderShipped)).toBe(true)
  })

  test('forget removes direct listeners', async () => {
    dispatcher.listen('probe', () => 'x')
    dispatcher.forget('probe')

    expect(await dispatcher.dispatch('probe')).toEqual([])
  })

  test('forget removes a wildcard pattern', async () => {
    dispatcher.listen('order.*', () => 'x')
    dispatcher.forget('order.*')

    expect(await dispatcher.dispatch('order.created')).toEqual([])
  })

  test('forget accepts an event class', () => {
    dispatcher.listen(OrderShipped, () => {})
    dispatcher.forget(OrderShipped)

    expect(dispatcher.hasListeners(OrderShipped)).toBe(false)
  })

  test('subscribers register their own listeners', async () => {
    const seen: string[] = []

    dispatcher.subscribe({
      subscribe(events) {
        events.listen('one', () => {
          seen.push('one')
        })
        events.listen('two', () => {
          seen.push('two')
        })
      }
    })

    await dispatcher.dispatch('one')
    await dispatcher.dispatch('two')

    expect(seen).toEqual(['one', 'two'])
  })
})

describe('deferred events', () => {
  test('push defers until flush', async () => {
    const seen: unknown[] = []
    dispatcher.listen('mail.sent', (payload) => {
      seen.push(payload)
    })

    dispatcher.push('mail.sent', { to: 'a@b.c' })
    expect(seen).toEqual([])

    await dispatcher.flush('mail.sent')
    expect(seen).toEqual([{ to: 'a@b.c' }])
  })

  test('forgetPushed drops deferred events without firing them', async () => {
    const seen: unknown[] = []
    dispatcher.listen('mail.sent', () => {
      seen.push('sent')
    })

    dispatcher.push('mail.sent')
    dispatcher.forgetPushed()
    await dispatcher.flush('mail.sent')

    expect(seen).toEqual([])
  })
})

describe('EventFake', () => {
  test('records instead of invoking', async () => {
    const fake = new EventFake()
    let called = false

    fake.listen(OrderShipped, () => {
      called = true
    })
    await fake.dispatch(new OrderShipped(3))

    expect(called).toBe(false)
    fake.assertDispatched(OrderShipped)
    expect(fake.dispatched(OrderShipped)).toHaveLength(1)
  })

  test('assertDispatched can require a count', async () => {
    const fake = new EventFake()

    await fake.dispatch(new OrderShipped(1))
    await fake.dispatch(new OrderShipped(2))

    fake.assertDispatched(OrderShipped, 2)
    expect(() => fake.assertDispatched(OrderShipped, 1)).toThrow(/2/)
  })

  test('assertNotDispatched and assertNothingDispatched', async () => {
    const fake = new EventFake()

    fake.assertNothingDispatched()
    fake.assertNotDispatched(OrderShipped)

    await fake.dispatch('something')

    expect(() => fake.assertNothingDispatched()).toThrow(/something/)
    expect(() => fake.assertDispatched(OrderShipped)).toThrow(/order.shipped/)
  })

  test('events in the except list still dispatch for real', async () => {
    const fake = new EventFake([OrderShipped])
    let called = false

    fake.listen(OrderShipped, () => {
      called = true
    })
    await fake.dispatch(new OrderShipped(1))
    await fake.dispatch('other')

    expect(called).toBe(true)
    fake.assertDispatched(OrderShipped)
    fake.assertDispatched('other')
  })
})

describe('NullDispatcher', () => {
  test('swallows dispatches but keeps registration observable', async () => {
    const nullDispatcher = new NullDispatcher()
    let called = false

    nullDispatcher.listen('probe', () => {
      called = true
    })

    expect(nullDispatcher.hasListeners('probe')).toBe(true)
    expect(await nullDispatcher.dispatch('probe')).toEqual([])
    expect(await nullDispatcher.until('probe')).toBeNull()
    expect(called).toBe(false)
  })

  test('push is a no-op, so flush fires nothing', async () => {
    const nullDispatcher = new NullDispatcher()
    let called = false

    nullDispatcher.listen('probe', () => {
      called = true
    })
    nullDispatcher.push('probe')
    await nullDispatcher.flush('probe')

    expect(called).toBe(false)
  })
})
