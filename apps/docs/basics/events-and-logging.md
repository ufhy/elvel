# Events and logging

Both follow `Illuminate\Events\Dispatcher` and `Illuminate\Log\LogManager`
semantics, read from the source rather than guessed:

```ts
// A class event is its own payload, and its listener's argument is typed.
class OrderShipped {
  static readonly eventName = 'order.shipped'   // survives class renaming
  constructor(readonly orderId: number) {}
}

events().listen(OrderShipped, (event) => event.orderId)   // typed
events().listen('order.*', (name, payload) => {})         // wildcard
await dispatch(new OrderShipped(42))
```

- a listener returning `false` stops propagation; `until()` returns the first
  non-null response and skips the rest
- wildcard matches are cached per event name and invalidated when a new pattern
  is registered
- `push()`/`flush()` defer through a synthetic `<event>_pushed` event
- classes in `app/Listeners` with a `subscribe` method are discovered
  automatically; `EventFake` records dispatches for tests and `NullDispatcher`
  swallows them while keeping registration observable

A listener can run in a worker instead of the request. It is a **class** rather
than a closure, for the same reason a job is: the worker is another process, so
only a name travels.

```ts
export class NotifyWarehouse extends QueuedListener<OrderShipped> {
  static override queue = 'shipments'
  static override tries = 3
  static override afterCommit = true          // wait for the commit, or drop it

  async handle(event: OrderShipped) {
    event.label()                             // the event is rebuilt as itself
  }

  override failed(event: OrderShipped, error: unknown) {}
}

events().listen(OrderShipped, NotifyWarehouse)   // pushed, not called
```

- `app/Events` is discovered into a registry, so the worker rebuilds the event
  from its class — its methods and `instanceof` survive the trip, which handing
  over loose JSON would not
- `shouldQueue(event)` is asked in the process that dispatched, the only one that
  still has the request's state
- `afterCommit` holds the push until the outermost transaction commits and drops
  it if that transaction rolls back; without it a worker can reserve a job whose
  rows were never committed
- the dispatcher knows nothing about queues — the push is a hook installed by
  `QueueServiceProvider`, and a queued listener with no queue registered **throws**
  rather than quietly running in the request
- `elvel make:listener NotifyWarehouse --event OrderShipped --queued` writes one

```ts
log().info('User {id} signed in', { id: 7 })    // {placeholders} interpolate
log().channel('daily').warning('Disk filling')
log().shareContext({ request_id: id })          // sticks to every channel
log().extend('pino', (config) => new PinoDriver(config))
```

Channels pair a driver with a minimum level, using the same eight RFC 5424
levels and Monolog's severity numbers, so a `level` behaves as it does in
Laravel. A typo in a level or a stack that includes itself fails at boot rather
than at 3am. Logging is fire-and-forget: `log().info()` never awaits its driver,
so a file write cannot slow a request.

`config/logging.ts` also carries an opt-in access log (`LOG_REQUESTS=true`) that
attaches a request id and reports method, path, status and duration.
