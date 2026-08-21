# Events and logging

## Dispatching

```ts
import { dispatch, events } from '@elvel/events'

class OrderPaid {
  constructor(readonly id: number) {}
}

events().listen(OrderPaid, (event) => sendReceipt(event.id))

await dispatch(new OrderPaid(7))
```

A class-based event **is its own payload**, which is what makes
`dispatch(new OrderPaid(7))` read the way it does. A string event takes one:

```ts
events().listen('order.shipped', (payload) => …)

await dispatch('order.shipped', { at: Date.now() })
```

`bun elvel make:event OrderPaid` and `make:listener SendReceipt` write the files;
`event:list` shows what is registered.

## Wildcards, and ancestors

```ts
events().listen('order.*', (name, payload) => audit(name))
events().listen('*.deleted', (name) => …)
```

A wildcard listener receives the **resolved name first**, which is how one
listener can serve many events. Run against listeners on `OrderPaid`,
`order.shipped`, `order.*` and a `DomainEvent` base class:

```
dispatch(new OrderPaid(7))            → class:7
dispatch('order.shipped', { at: 1 })  → string:{"at":1}, wildcard:order.shipped
dispatch(new UserRegistered('…'))     → ancestor
```

That last line is the one worth knowing. **A listener registered on an ancestor
class runs too.** Laravel matches a listener registered on an interface the event
implements; TypeScript erases interfaces so there is nothing at runtime to match,
but a base class survives and carries the same meaning — `listen(DomainEvent, …)`
hears everything that extends it.

Note also what did *not* fire: `order.*` did not match `OrderPaid`, because a
class event is named from the class. Wildcards match names, so name events with
dots if you want to group them.

```ts
events().registered()
// { exact: [['OrderPaid', 1], ['order.shipped', 1]], wildcards: [['order.*', 1]] }
```

## Asking a question

```ts
const answer = await events().until('question')
```

`until` stops at the **first non-null response** and returns it. Three listeners
returning `undefined`, `'answer'` and `'never reached'` give `'answer'` — the
third never runs.

Returning exactly `false` from any listener stops propagation, halting or not:

```
listeners: [() => false, () => push('two')]   →  ['one']
```

## Deferring, and the half-finished write

```ts
await events().defer(async () => {
  const order = await Order.create(…)
  await dispatch(new OrderPaid(order.id))
  await takePayment(order)          // if this throws, nothing was announced
})
```

Nothing is dispatched until the body finishes:

```
inside defer, held: []
after defer:        ['ran']
```

And a throw **drops** them rather than dispatching or retrying. That is the point:
without it, an order is created, two listeners email the customer, and the third
step fails — leaving them told about an order that no longer exists.

`defer(body, ['order.paid'])` holds that one event and lets everything else
through.

::: tip `until()` is never deferred
A halting dispatch is a *question* and the caller wants the answer. Deferring one
would answer `null` and carry on, which is worse than not deferring it.
:::

## Queued listeners

A listener that should not run inside the request can be queued, and then only its
**name** travels — the same constraint jobs and mailables have, for the same
reason. `setQueue()` wires the pusher; the [queue page](/digging-deeper/queues)
has the rest.

## Subscribers

```ts
events().subscribe(new OrderSubscriber())
```

One class declaring several listeners, when they belong together.

## Testing

```ts
const fake = events().fake()

await dispatch(new OrderPaid(7))

fake.assertDispatched(OrderPaid)
fake.assertDispatched(OrderPaid, 1)
fake.assertNotDispatched(OrderRefunded)
fake.assertNothingDispatched()
```

---

# Logging

```ts
import { log } from '@elvel/log'

log().info('an info line', { user: 7 })
log().error('order {id} failed for {user}', { id: 'A1', user: 'ada' })
```

Eight levels, in descending severity: `emergency`, `alert`, `critical`, `error`,
`warning`, `notice`, `info`, `debug`.

**`{placeholders}` are interpolated from the context**, and the context is kept as
well:

```
order A1 failed for ada   { id: 'A1', user: 'ada' }
```

So a human reads the sentence and a collector still gets the fields. Nothing has
to be written twice.

```ts
log().withContext({ requestId: 'r-1' }).info('carries context')
log().channel('json').warning('to one channel')
```

## Channels

```ts
// config/logging.ts
default: env('LOG_CHANNEL', 'stack'),

channels: {
  stack:   { driver: 'stack', channels: ['console'] },
  console: { driver: 'console', level: env('LOG_LEVEL', 'debug') },
  json:    { driver: 'json', stream: 'stdout', level: env('LOG_LEVEL', 'info') },
  single:  { driver: 'single', level: 'debug' },
  daily:   { driver: 'daily', maxFiles: 14 }
}
```

`console` is coloured and shaped for a person; `json` writes one object per line
for a collector. `errorlog` writes plain lines to stderr, which is what a
container runtime collects — a file inside a container is a file nobody reads
before it is destroyed.

A `stack` fans one record out to several channels, **and each keeps its own
level**:

```ts
stack: { driver: 'stack', channels: ['console', 'json'] },
console: { driver: 'console', level: 'debug' },
json:    { driver: 'json', level: 'warning' }
```

An `info` line then reaches the console and not the JSON stream.

::: warning This was broken in every alpha up to and including `alpha.9`
A level is enforced by the `Logger`, not by the driver beneath it — and a stack
was built from bare **drivers**, so every member's threshold was discarded and
only the stack's own applied. Since `stack` is the default channel, that was the
ordinary path: the levels in `config/logging.ts` were ignored wherever anybody had
set one. Writing this page found it.
:::

## Following the log

```bash
bun elvel log:tail
bun elvel log:tail --level=error --filter=payment --lines=200
```

`--path` when it is not the single channel's file.

## Every write is an event

`MessageLogged` is dispatched for each record, so a listener can forward to
somewhere the drivers do not cover — an APM, an alert — without wrapping every
call site.
