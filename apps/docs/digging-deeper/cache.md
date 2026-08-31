# Cache

Four stores behind one interface, atomic locks on every one of them, tags, a
rate limiter and a semaphore.

```ts
import { cache } from '@elvel/cache'

await cache().put('key', { a: 1 }, 60)   // 60 seconds
await cache().get('key')                 // { a: 1 }
await cache().get('missing', 'fallback')
```

`cache('redis')` names a store; `cache()` uses the default from
`config/cache.ts`.

## Reading and writing

```ts
await cache().has('key')
await cache().missing('key')
await cache().add('once', 1, 60)     // true, then false — write only if absent
await cache().forever('key', value)
await cache().pull('key')            // read it and delete it
await cache().forget('key')
await cache().flush()
```

`increment` and `decrement` return the new value:

```ts
await cache().increment('hits')      // 1
await cache().increment('hits', 5)   // 6
```

`many` and `putMany` do several at once, and `touch` extends a key's life
without rewriting it.

### Typed reads

```ts
await cache().integer('hits')                // 6
await cache().string('missing', 'fallback')  // 'fallback'
await cache().boolean('flag', false)
await cache().float('rate')
await cache().array<Row>('rows')
```

A cache round trip loses types — everything comes back as whatever JSON made of
it — so these coerce and take a fallback rather than handing you `unknown`.

## `remember`

The pattern that is nine tenths of cache use:

```ts
const stats = await cache().remember('stats', 300, async () => expensive())
```

Called twice, the callback runs once. `rememberForever` has no expiry, and
`sear` is Laravel's alias for it.

## `flexible` — stale while revalidate

```ts
await cache().flexible('report', [60, 600], () => buildReport())
```

Two windows: fresh for 60 seconds, alive for 600. Inside the first, the cached
value is returned. Between them the **cached value is still returned** and a
refresh is scheduled to run after the response is sent, so nobody waits for it.
Past 600 seconds it is a plain miss.

Watched from the outside, with a one-second fresh window:

```
1st: v1  (built)
2nd: v1  (fresh)
3rd: v1  (stale — served old, refresh deferred)
4th: v2  (refreshed)
```

The refresh takes a lock where the store has one, so a burst on the same stale
key schedules one rebuild rather than one per request. A failed background
refresh cannot surface as a failure of the request that triggered it.

## Locks

```ts
const lock = cache().lock('import', 10)

await lock.get(async () => {
  // held for at most 10 seconds
})
```

`get()` returns false rather than running when the lock is taken. `block(seconds)`
waits for it instead, and throws `LockTimeoutError` when the wait runs out.
`restoreLock(name, owner)` rebuilds a lock from the owner token `lock.owner()`
returned, so a different process — or the same one after a restart — can release
a lock it did not take.

The shorthand:

```ts
await cache().withoutOverlapping('report', () => buildReport(), { lockFor: 30, waitFor: 10 })
```

Every store here provides locks, including `file` and `array`. A store that did
not would throw rather than pretend, because a lock that silently does nothing is
worse than no lock.

## Funnels — N at a time

```ts
await cache().funnel('reports').limit(3).releaseAfter(60).block(10, async () => {
  await generateReport()
})
```

`withoutOverlapping()` is the N=1 case, and nearly every real constraint is not
1: an API that allows three concurrent calls, a report generator that exhausts
memory at four, a legacy database with a small pool. Forcing those through one
lock turns concurrent work into a queue.

Laravel's funnel is Redis-only, because it takes a slot with a Lua script. This
one is not: a lock is already atomic on every driver here, so N named locks are a
semaphore that behaves the same on `array`, `file`, `database` and `redis`.

::: warning Never `await` a funnel itself
`Funnel` has a `then()` method, because that is what Laravel calls it — which
makes the object thenable. `await funnel` would hand the promise machinery's
`resolve` a slot. Always call it: `funnel.then(cb)` or `funnel.block(10, cb)`.
:::

Measured with four callers and `limit(2)`, the peak concurrency is 2.

## Rate limiting

```ts
import { limiter } from '@elvel/cache'

const result = await limiter().attempt('login:' + ip, 2, () => signIn(), 60)

if (result === false) {
  // too many
}
```

```
attempt        → 'ok'
attempt        → 'ok'
attempt (3rd)  → false
remaining      → 0
availableIn    → 60
```

`hit`, `attempts`, `remaining`, `resetAttempts` and `clear` are there for the
cases where you want the counter without the callback. Two keys are stored per
limit — the counter and a timer — because `availableIn()` needs the moment the
window closes, and because a counter that outlived its window cannot otherwise be
told apart from one that is genuinely exhausted.

The HTTP middleware `throttle:60,1` uses this, so the same counters are visible
to both.

## Tags

```ts
await cache().tags('people', 'authors').put('ada', 1, 60)

await cache().tags('people', 'authors').get('ada')  // 1
await cache().get('ada')                            // null — a tagged key is its own key

await cache().tags('people').flush()                // drops it
```

`supportsTags()` says whether the current store can. Flushing one tag drops
everything filed under it, which is the point: cache invalidation by subject
rather than by remembering every key you wrote.

## Stores

```ts
// config/cache.ts
default: env('CACHE_STORE', 'file'),
prefix: env('CACHE_PREFIX', 'elvel_cache_'),
limiter: env('CACHE_LIMITER', 'array'),

stores: {
  array: { driver: 'array' },
  file: { driver: 'file' },
  database: { driver: 'database', table: 'cache', lockTable: 'cache_locks' },
  redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379') }
}
```

`array` is per-process memory and gone with the process. `file` is the default
because it needs no service and survives a restart. `database` needs
`bun elvel cache:table && bun elvel migrate`.

The prefix exists so two applications can share one Redis or one cache table
without colliding — and changing it is a cache flush by another name.

## A memory tier in front of the store

```ts
// config/cache.ts
memory: 1
```

Off by default. Set to a number of seconds, it keeps values in process memory for
that long in front of whatever store is configured. A `get` against the file store
costs about 26µs and 96% of that is the filesystem read, so the only way to make a
hot key cheap is not to go to the store at all — 25µs becomes 0.09µs.

**It trades freshness for that, and the trade is real.** A cache is shared: another
process — a second web worker, a queue worker, a `bun elvel` command — can write a
key this process is still serving from memory. Writes made *here* drop the entry
immediately, so a single-process application never sees a stale value; a
multi-process one sees at most `memory` seconds of staleness after somebody else's
write.

One second suits configuration, feature flags and permission maps: things read on
every request and changed by a deploy. Do not put it in front of a counter, a rate
limiter or a lock — those are read-modify-write, and a stale read there is a wrong
answer rather than an old one. Counters and locks pass straight through for exactly
that reason.

## Events

`cache.hit`, `cache.missed`, `cache.written` and `cache.forgotten` are
dispatched with the key, so a listener can measure a hit rate without wrapping
every call site.

## Commands

```bash
bun elvel cache:clear                 # flush the application cache
bun elvel cache:forget <key>
bun elvel cache:prune                 # expired rows, database store only
bun elvel cache:table                 # write the migration
```
