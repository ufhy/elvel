import { beforeEach, describe, expect, test } from 'bun:test'
import { Dispatcher, eventName } from '../src/dispatcher.ts'
import { EventRegistry } from '../src/event-registry.ts'
import { EventFake, NullDispatcher } from '../src/fake.ts'
import { QueuedListener } from '../src/listener.ts'

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

describe('queued listeners', () => {
  class SendShipmentNotification extends QueuedListener<OrderShipped> {
    static override queue = 'notifications'
    static override tries = 5
    static handled: number[] = []

    handle(event: OrderShipped): void {
      SendShipmentNotification.handled.push(event.orderId)
    }
  }

  /** What the queue would receive, captured instead of pushed. */
  let pushed: Array<{ listener: string; event: string; payload: unknown }>

  beforeEach(() => {
    pushed = []
    SendShipmentNotification.handled = []

    dispatcher.setQueue((listener, event) => {
      pushed.push({ listener: listener.name, event: event.name, payload: event.payload })
    })
  })

  test('a queued listener is pushed, not run', async () => {
    dispatcher.listen(OrderShipped, SendShipmentNotification)

    await dispatcher.dispatch(new OrderShipped(7))

    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.listener).toBe('SendShipmentNotification')
    expect(pushed[0]?.event).toBe('order.shipped')
    // The whole point: nothing ran in this process.
    expect(SendShipmentNotification.handled).toEqual([])
  })

  test('the event travels as the payload', async () => {
    dispatcher.listen(OrderShipped, SendShipmentNotification)

    await dispatcher.dispatch(new OrderShipped(9))

    expect((pushed[0] as { payload: OrderShipped }).payload.orderId).toBe(9)
  })

  test('it is registered so a worker can resolve it by name', () => {
    dispatcher.listen(OrderShipped, SendShipmentNotification)

    expect(dispatcher.queuedListeners.names()).toEqual(['SendShipmentNotification'])
    expect(dispatcher.queuedListeners.get('SendShipmentNotification')).toBe(
      SendShipmentNotification as never
    )
  })

  test('shouldQueue can refuse, in the process that has the request', async () => {
    class OnlyLarge extends QueuedListener<OrderShipped> {
      override shouldQueue(event: OrderShipped): boolean {
        return event.orderId > 100
      }

      handle(): void {}
    }

    dispatcher.listen(OrderShipped, OnlyLarge)

    await dispatcher.dispatch(new OrderShipped(5))
    expect(pushed).toHaveLength(0)

    await dispatcher.dispatch(new OrderShipped(500))
    expect(pushed).toHaveLength(1)
  })

  test('a queued listener with no queue says so rather than running', async () => {
    const orphan = new Dispatcher()
    orphan.listen(OrderShipped, SendShipmentNotification)

    // No silent fallback: running it in the request would look like it worked.
    await expect(orphan.dispatch(new OrderShipped(1))).rejects.toThrow(/no queue is registered/)
  })

  test('a subclass of a project base class still counts as queued', async () => {
    abstract class ProjectListener<E> extends QueuedListener<E> {}
    class Deeper extends ProjectListener<OrderShipped> {
      handle(): void {}
    }

    dispatcher.listen(OrderShipped, Deeper)
    await dispatcher.dispatch(new OrderShipped(1))

    expect(pushed[0]?.listener).toBe('Deeper')
  })

  test('a queued listener may listen on a pattern', async () => {
    // It used to refuse: a wildcard listener is handed the resolved name, and
    // there was no way to carry that to a worker. The payload carries it now.
    dispatcher.listen('order.*', SendShipmentNotification as never)

    await dispatcher.dispatch('order.shipped', { id: 3 })

    expect(pushed[0]?.listener).toBe('SendShipmentNotification')
    expect(pushed[0]?.event).toBe('order.shipped')
  })

  test('a plain closure listener still runs inline', async () => {
    const seen: number[] = []
    dispatcher.listen(OrderShipped, (event) => seen.push(event.orderId))

    await dispatcher.dispatch(new OrderShipped(3))

    expect(seen).toEqual([3])
    expect(pushed).toHaveLength(0)
  })

  test('listenerName overrides the class name, for a build that renames', () => {
    class Renamed extends QueuedListener<OrderShipped> {
      static override listenerName = 'shipment.notify'

      handle(): void {}
    }

    dispatcher.listen(OrderShipped, Renamed)

    expect(dispatcher.queuedListeners.names()).toEqual(['shipment.notify'])
  })
})

describe('EventRegistry', () => {
  test('an event comes back as itself, methods and all', () => {
    class Shipped {
      constructor(readonly orderId: number) {}

      label(): string {
        return `order-${this.orderId}`
      }
    }

    const registry = new EventRegistry()
    registry.register(Shipped)

    // What a worker has: the name and the data, never the object.
    const rebuilt = registry.hydrate('Shipped', JSON.parse(JSON.stringify(new Shipped(4))))

    expect(rebuilt).toBeInstanceOf(Shipped)
    expect((rebuilt as Shipped).label()).toBe('order-4')
  })

  test('the constructor is not re-run', () => {
    let constructed = 0

    class Counted {
      constructor(readonly id: number) {
        constructed += 1
      }
    }

    const registry = new EventRegistry()
    registry.register(Counted)
    constructed = 0

    const rebuilt = registry.hydrate('Counted', { id: 1 }) as Counted

    // Rebuilding is not creating: a constructor may take a model, or may have
    // already had its side effect once.
    expect(constructed).toBe(0)
    expect(rebuilt.id).toBe(1)
  })

  test('a static eventName is the key', () => {
    class Named {
      static readonly eventName = 'order.shipped'
    }

    const registry = new EventRegistry()
    registry.register(Named)

    expect(registry.names()).toEqual(['order.shipped'])
    expect(registry.hydrate('order.shipped', {})).toBeInstanceOf(Named)
  })

  test('an unregistered event hands over its data unchanged', () => {
    const registry = new EventRegistry()

    expect(registry.hydrate('Unknown', { id: 1 })).toEqual({ id: 1 })
    expect(registry.hydrate('Unknown', 'a string')).toBe('a string')
    expect(registry.hydrate('Unknown', null)).toBeNull()
  })
})

describe('a queued listener on a pattern', () => {
  test('it queues, and is told which event it was', async () => {
    const pushed: Array<{ listener: string; event: string; payload: unknown }> = []

    class RecordEverything extends QueuedListener<unknown> {
      async handle(): Promise<void> {
        // The worker runs this; the dispatcher only pushes.
      }
    }

    const dispatcher = new Dispatcher()
    dispatcher.setQueue(async (listener, event) => {
      pushed.push({ listener: listener.name, event: event.name, payload: event.payload })

      return 'job-id'
    })

    dispatcher.listen('order.*', RecordEverything as never)

    await dispatcher.dispatch('order.shipped', { id: 7 })
    await dispatcher.dispatch('order.cancelled', { id: 8 })

    // Both matched, and each carries the resolved name — `order.*` cannot tell
    // shipped from cancelled by looking at the payload.
    expect<number>(pushed.length).toBe(2)
    expect<string | undefined>(pushed[0]?.event).toBe('order.shipped')
    expect<string | undefined>(pushed[1]?.event).toBe('order.cancelled')
  })
})

describe('listening on a base class', () => {
  class DomainEvent {}
  class OrderPlaced extends DomainEvent {
    constructor(readonly id: number) {
      super()
    }
  }

  test('a listener on the ancestor hears the descendant', async () => {
    const heard: string[] = []
    const dispatcher = new Dispatcher()

    dispatcher.listen(DomainEvent as never, () => {
      heard.push('ancestor')
    })
    dispatcher.listen(OrderPlaced as never, () => {
      heard.push('own')
    })

    await dispatcher.dispatch(new OrderPlaced(1))

    // Laravel matches interfaces; TypeScript erases those, but a base class
    // survives and carries the same meaning. Most specific first.
    expect<string[]>(heard).toEqual(['own', 'ancestor'])
  })

  test('a specific listener can stop the general ones', async () => {
    const heard: string[] = []
    const dispatcher = new Dispatcher()

    dispatcher.listen(OrderPlaced as never, () => {
      heard.push('own')

      return false
    })
    dispatcher.listen(DomainEvent as never, () => {
      heard.push('ancestor')
    })

    await dispatcher.dispatch(new OrderPlaced(1))

    expect<string[]>(heard).toEqual(['own'])
  })

  test('a string event walks nothing', async () => {
    const heard: string[] = []
    const dispatcher = new Dispatcher()

    dispatcher.listen('order.placed', () => {
      heard.push('named')
    })

    await dispatcher.dispatch('order.placed', { id: 1 })

    expect<string[]>(heard).toEqual(['named'])
  })
})

describe('defer', () => {
  const heard: string[] = []

  const dispatcher = () => {
    const events = new Dispatcher()

    events.listen('order.paid', () => {
      heard.push('paid')
    })
    events.listen('order.shipped', () => {
      heard.push('shipped')
    })

    return events
  }

  beforeEach(() => {
    heard.length = 0
  })

  test('nothing is heard until the callback returns', async () => {
    const events = dispatcher()

    const result = await events.defer(async () => {
      await events.dispatch('order.paid')
      await events.dispatch('order.shipped')

      // Still inside: the work is not finished, so nobody has been told.
      expect<string[]>(heard).toEqual([])

      return 'done'
    })

    expect(result).toBe('done')
    expect<string[]>(heard).toEqual(['paid', 'shipped'])
  })

  test('a throw means nothing was announced at all', async () => {
    const events = dispatcher()

    await expect(
      events.defer(async () => {
        await events.dispatch('order.paid')

        throw new Error('the invoice failed')
      })
    ).rejects.toThrow('the invoice failed')

    // The whole reason to reach for this: half the work leaves no trace of
    // having happened, rather than an email about an order that was rolled back.
    expect<string[]>(heard).toEqual([])
  })

  test('naming events defers those and lets the rest through', async () => {
    const events = dispatcher()

    await events.defer(async () => {
      await events.dispatch('order.paid')
      await events.dispatch('order.shipped')

      expect<string[]>(heard).toEqual(['shipped'])
    }, ['order.paid'])

    expect<string[]>(heard).toEqual(['shipped', 'paid'])
  })

  test('a dispatch outside the callback is untouched', async () => {
    const events = dispatcher()

    // Two overlapping pieces of work in one process: the deferral belongs to the
    // callback's async context, not to the dispatcher, so the other one is not
    // silently held — or worse, dropped when this one throws.
    const deferred = events.defer(async () => {
      await events.dispatch('order.paid')
      await Bun.sleep(20)
    })

    await events.dispatch('order.shipped')
    expect<string[]>(heard).toEqual(['shipped'])

    await deferred
    expect<string[]>(heard).toEqual(['shipped', 'paid'])
  })

  test('until() answers from the listeners, deferral or not', async () => {
    const events = new Dispatcher()
    events.listen('is.allowed', () => 'yes')

    await events.defer(async () => {
      // A halting dispatch is a question; deferring it would answer null before
      // anybody had been asked.
      expect(await events.until('is.allowed')).toBe('yes')
    })
  })

  test('a fake records the deferred events, and not the abandoned ones', async () => {
    const fake = new EventFake()

    await fake.defer(async () => {
      await fake.dispatch('order.paid')
    })

    await fake
      .defer(async () => {
        await fake.dispatch('order.shipped')

        throw new Error('no')
      })
      .catch(() => undefined)

    fake.assertDispatched('order.paid')
    fake.assertNotDispatched('order.shipped')
  })
})
