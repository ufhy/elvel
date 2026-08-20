# Broadcasting

One websocket endpoint, a channel registry that decides who may listen, and
Redis pub/sub when the application runs as more than one process.

```ts
import { broadcast, channels } from '@elvel/broadcasting'

// Who may listen — app/Providers/AppServiceProvider.ts
channels().channel('orders.{id}', (user, params) => user?.id === Number(params.id))

channels().presence('room.{name}', (user, params) =>
  user ? { id: user.id, name: user.name, room: params.name } : null
)

channels().public('prices')

// Somewhere that has news
await broadcast('orders.42', 'order.shipped', { at: Date.now() })
```

## A channel name is a pattern

```
matchChannel('orders.{id}', 'orders.42')     → { id: '42' }
matchChannel('orders.{id}', 'invoices.42')   → undefined
```

That shape is what makes authorisation expressible at all: "may this user listen
to *this* order" is a different question per order, and a list of literal channel
names cannot ask it. The callback receives the matched parameters as strings.

## A channel nobody declared is refused

```
authorize('orders.42', { id: 42 })    → true    // the owner
authorize('orders.42', { id: 7 })     → false   // a stranger
authorize('secret.thing', { id: 42 }) → false   // never declared
```

That last line is the decision worth stating. A socket subscribing to a name the
server has never heard of is either a bug or a probe, and the other default —
broadcasting a private channel to whoever asks — is the one that ends up in an
incident report.

## Presence channels answer with the member

```ts
channels().presence('room.{name}', (user, params) =>
  user ? { id: user.id, name: `u${user.id}`, room: params.name } : null
)
```

```
authorize('room.lobby', { id: 3 })  → true
member('room.lobby', { id: 3 })     → { id: 3, name: 'u3', room: 'lobby' }
```

Authorising and identifying are **one question**, because a member list of people
who were not allowed in is not a member list. Returning `null` or `false` refuses.

`isPresence(name)` tells the two kinds apart, and `patterns()` lists what the
application declared:

```
['orders.{id}', 'room.{name}']
```

## Listening from a browser

One endpoint — `/broadcast` by default — and you subscribe over it:

```js
const socket = new WebSocket('ws://localhost:3000/broadcast')

socket.onopen = () => socket.send(JSON.stringify({ subscribe: 'orders.42' }))

socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  // { event: 'subscribed', channel: 'orders.42' }  — or 'refused'
  // { event: 'order.shipped', channel: 'orders.42', payload: … }
}
```

One socket per tab rather than one per channel, which is how every client library
in this space works. The protocol is deliberately tiny —
`{"subscribe":"orders.7"}` and `{"unsubscribe":"orders.7"}` — because anything
larger is a client library's job, and a server that invents its own framing
forces everybody to write one.

A refused subscription is answered, not ignored: `{"event":"refused"}` tells the
client the difference between "not allowed" and "nothing has happened yet".

::: tip The user is captured when the socket opens
A socket outlives the request that opened it, so by the time a `subscribe`
arrives the auth scope is long gone. The user is read once, at `open`, which is
the only point at which they are still knowable.
:::

## More than one process

```ts
// config/broadcasting.ts
driver: process.env.BROADCAST_DRIVER ?? 'memory',
path: process.env.BROADCAST_PATH ?? '/broadcast',
redis: { url: …, prefix: 'elvel:' }
```

`memory` fans an event out to the sockets **this process** is holding. That is the
whole story for one server and for every development machine, so it is the
default: requiring Redis to send an event to a socket in your own process would
be requiring it for nothing.

Behind a load balancer one process holds half the sockets and another holds the
rest, and with `memory` the second half never hears the event. On `redis` every
broadcast goes to the bus and every process — including the one that published it
— writes it out to the sockets it holds. Nothing else changes: the same
`broadcast()`, the same channels, the same authorisation. The `prefix` keeps two
applications on one Redis apart.

## Notifications can broadcast

A notification listing `broadcast` in `via()` goes out on a channel named after
the recipient, which is how an in-app toast and a stored inbox row come from the
same event. The [notifications page](/digging-deeper/notifications) has that side.

## Commands

```bash
bun elvel make:channel OrderChannel
bun elvel channel:list          # every declared pattern, --json for a machine
```
