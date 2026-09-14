# Redis

`@elvel/redis` is one manager for every Redis connection an application has. The
cache, the queue and the broadcaster each used to open a client of their own from
their own config key, so an application using all three named the same server in
three places and held at least four connections in every process — and every
worker multiplied that. With this package registered they resolve a named
connection from it instead.

It is optional. Nothing needs it: each of those packages still opens its own
client when the manager is not bound, and works exactly as it did.

## Installation

```bash
bun add @elvel/redis
bun elvel config:publish redis
```

Then register the provider in `config/app.ts`:

```ts
import { RedisServiceProvider } from '@elvel/redis'
```

Register it early. The cache, the queue and the broadcaster resolve their
connection while they register, and a manager that appeared afterwards would
have each of them build a client of its own first — which is the thing this
exists to stop.

## Configuration

```ts
// config/redis.ts
export default {
  default: process.env.REDIS_CONNECTION ?? 'default',

  connections: {
    default: {
      url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      prefix: process.env.REDIS_PREFIX ?? ''
    }
  }
}
```

An unconfigured name is an error rather than a default: a typo would otherwise
open a connection to localhost and fail somewhere far from the name that was
wrong.

## Using a connection

```ts
import { connection, redis } from '@elvel/redis'

await connection().send('ZADD', ['leaderboard', '10', 'ada'])
await connection('cache').client.get('users:1')

redis().names() // ['default', 'cache', 'cluster']
```

`send()` takes a command and its arguments. `client` is Bun's own `RedisClient`,
for the sugar — `get`, `set`, `incrby` and the rest.

## Several nodes

```ts
cluster: {
  nodes: ['redis://a:6379', 'redis://b:6379', 'redis://c:6379']
}
```

A key routes to the same node every time, which is what a cache or a set of
queues needs. This is a hash ring over clients and not cluster protocol support:
it does not follow a `MOVED` redirect, so a cluster that reshards while running
needs a client that speaks the protocol.

## Commands as events

Every command dispatches `redis.command` with its name, its arguments, the
connection it ran on and how long it took — and `redis.command.failed` when it
did not finish.

```ts
import { CommandExecuted } from '@elvel/redis'

Event.listen(CommandExecuted, (event) => {
  if (event.duration > 50) log.warning(`slow redis: ${event.command}`)
})
```

The event is built only when something is listening, so a worker polling every
few milliseconds allocates nothing.

Lens has a watcher for these. It is off by default because without this package
the events never fire:

```ts
// config/lens.ts
redis: { enabled: true, ignore: ['BLPOP'] }
```

`ignore` is worth setting for a worker's blocking read, which would otherwise be
most of the timeline.

## Sharing, in detail

| Package | What it shares | What it still opens |
| --- | --- | --- |
| `@elvel/cache` | the client | — |
| `@elvel/queue` | the client | one for `BLPOP`, which holds its connection |
| `@elvel/broadcasting` | the publisher | one subscriber, which may issue nothing else |

The connection's own `prefix` sits in front of each package's — `app:` plus
`queues:` is `app:queues:` — so two applications on one server stay apart with
one setting.
