# Gaps

Only what must still be built. A row is **deleted** when the work lands, never
narrowed — the length of this file measures the work left, and a file that cannot
shrink measures nothing. Behaviour that exists and merely surprises belongs in
`BEHAVIOURS.md`.

Measured against **`github.com/laravel/framework` v13.31.0** (released
2026-09-08), read as source, one component at a time — not against the
documentation. That tag is the only place it is named: everywhere below it is
"upstream", because a measurement needs a baseline and a gap row does not need a
brand.

**Open: 88** — all 37 components measured.

Twelve added none: Concurrency, Conditionable, Config, Contracts, Encryption,
Hashing, JsonSchema, Notifications, Reflection, Scheduling, Session and Support.
Four are ahead of upstream rather than level with it, and the reasons are at the
bottom.

Scheduling sits inside Console upstream; here it is a package of its own and is
measured separately.

---

## Auth

### HTTP Basic authentication does not exist

Upstream has three doors into it: the `auth.basic` middleware
(`Illuminate/Auth/Middleware/AuthenticateWithBasicAuth.php`), `Auth::basic()`,
and `Auth::onceBasic()` for a stateless check. `SessionGuard::basic()` reads the
`Authorization: Basic` header, attempts against the user provider, and answers
`401` with a `WWW-Authenticate` challenge.

Elvel has none of it. The only `Basic` in the repository is the **outgoing**
client's `withBasicAuth` in `packages/http-client`. There is no way to put a
username and password in front of a route — the thing every internal tool, every
staging environment and every `/metrics` endpoint reaches for first.

**Done when** an `auth.basic` middleware alias exists, it challenges with
`WWW-Authenticate: Basic realm=…` on a missing or wrong credential, a stateless
variant leaves no session behind, and the credential comparison is
constant-time.

### Nothing is dispatched when somebody signs in

Upstream dispatches fourteen events from `Illuminate/Auth/Events`: `Attempting`,
`Validated`, `Login`, `Authenticated`, `Failed`, `Lockout`, `Logout`,
`CurrentDeviceLogout`, `OtherDeviceLogout`, `Registered`, `Verified`,
`PasswordReset`, `PasswordResetLinkSent`, and `GateEvaluated`.

Elvel dispatches **one** — `gate.evaluated`, in `packages/auth/src/gate.ts`. A
grep for `dispatch(` across `packages/auth/src` finds nothing else, and the
provider's better-auth `databaseHooks` are wired only to bump the session
revocation epoch.

The consequence is not cosmetic. "Log every failed sign-in", "notify on a new
device", "seed a workspace when a user registers", "audit password resets" are
all listener-shaped problems in upstream and have no seam at all here. Lens
cannot have an auth watcher for the same reason.

better-auth already calls hooks at each of these moments, so the work is a
bridge, not an implementation.

**Done when** signing in, signing out, failing, registering, verifying and
resetting each dispatch a named event carrying the user, an application can
`listen('auth.login')`, and Lens records them.

### The Gate cannot be asked what it knows

`Gate::abilities()` and `Gate::policies()` return the registrations. Elvel keeps
both as private `Map`s on the `Gate` class with no reader.

Small, and it is what a `route:list`-style command for authorisation would be
built on — and what tells you a policy you wrote is not being discovered.

**Done when** both are readable and `lens` or a console command can print them.

### `Gate::defaultDenialResponse()` is absent

Upstream lets an application set the response every denial falls back to, so an
API can answer `404` everywhere instead of `403` without writing
`denyAsNotFound()` in forty policies. `AuthorizationResponse` supports the
status; nothing configures the default.

**Done when** the gate takes a default denial response and `authorize()` uses it
where a policy returned a bare `false`.

---

## Broadcasting

The websocket server itself is not a gap and is worth saying once: presence
channels gather members across processes over the Redis bus, `here`/`joined`/`left`
follow Echo's contract, a second tab is not a second arrival, and a channel
nobody declared is refused. That is Reverb's design, built in.

### `toOthers()` has nothing to feed it

`Broadcastable.broadcastExcept()` exists in `packages/broadcasting/src/provider.ts`
and `Broadcaster.deliver()` honours it. Nothing can ever supply the value.

In upstream the loop closes in two places: the browser learns its socket id from
the connection, sends it back as `X-Socket-ID` on every request, and
`Broadcast::socket($request)` reads it into the event. Elvel closes neither end
— the `open` hook registers the subscriber and sends **nothing**, so the client
never learns its own id, and no code anywhere in the repository reads an
`X-Socket-ID` header.

The result is the first bug everybody writes: the client that posted the message
receives its own broadcast and renders it twice.

**Done when** the socket is told its id on connect, a request carrying
`X-Socket-ID` puts it where an event can reach it, and a broadcast raised during
that request skips that socket by default.

### Every broadcast is sent inline

Upstream queues a broadcast unless the event says otherwise: `ShouldBroadcast`
goes through the `BroadcastEvent` job on `broadcastQueue`/`broadcastConnection`,
`ShouldBroadcastNow` is the opt-out, and `afterCommit` holds it until the
transaction lands.

`wireBroadcastableEvents()` sends every one of them in the dispatching request.
On the Redis driver the publish is `void`ed, so a bus that is down loses the
broadcast and says nothing — no retry, no failed job, no log line. There is no
way to move a broadcast off the request path or to hold one until its
transaction commits, so an event broadcast inside a rolled-back transaction has
already gone out.

**Done when** a broadcastable event can name a queue, when the default is
queued and the inline path is the opt-out, when `afterCommit` is honoured, and
when a publish that fails is a failed job rather than silence.

### `broadcastWhen()` is absent

Upstream's event decides at dispatch time whether it broadcasts at all — the
usual case being a state machine that only announces some transitions. The
`Broadcastable` type has `broadcastOn`, `broadcastAs`, `broadcastWith` and
`broadcastExcept`, and no condition.

**Done when** an event that answers `broadcastWhen(): false` is dispatched and
not broadcast.

### There is no way to broadcast nowhere

`broadcasting.driver` is `redis` or, for every other value, `memory`. There is
no `log` driver to see what *would* have gone out without a socket in sight, and
no `null` driver to switch broadcasting off in CI. `BROADCAST_DRIVER=null` today
silently gives you `memory`.

**Done when** `log` and `null` are drivers, and an unknown driver name is an
error at boot rather than a silent fallback.

### No managed broker

Upstream ships Pusher and Ably drivers; Elvel holds the sockets itself. That is
the right default and it is the whole story on a server you control — but it is
not a story at all on a platform that will not let a process hold connections,
which is where the managed brokers are the only option.

**Done when** a broadcast can be handed to an external broker, or the
documentation states plainly that Elvel requires a host that keeps processes
alive.

### Nothing on the client

Upstream ships `laravel-echo`. Elvel documents the frame shapes —
`{"subscribe":"orders.7"}` — and stops there, so every application writes the
same reconnect loop, the same backoff, the same resubscribe-after-reconnect, and
the same presence bookkeeping, and gets the third one wrong.

**Done when** a browser client ships that reconnects, resubscribes what it held,
and exposes presence as a list rather than as three events to reduce by hand.

---

## Bus

Batching is not the gap. `PendingBatch` has `name`, `onSuccess`, `onFailure`,
`onFinished`, `allowFailures`, `onQueue`, `onConnection`; `Batch` has `progress`,
`processedJobs`, `failedJobIds`, `cancel`, `fresh`; a chain may be one entry of a
batch; a running job can reach its own batch and cancel it; and the callbacks are
job classes rather than serialised closures, which is the honest version of the
same idea. `ShouldBeUnique` and `afterCommit` are both there.

### `dispatchAfterResponse()` does not exist

Upstream's third dispatch mode: run the job in **this** process once the response
has been sent, with no queue and no worker. It is what a small side effect wants
— write an audit row, warm a cache — where queuing is more infrastructure than
the work is worth and `dispatchSync` would make the visitor wait for it.

`QueueManager` has `dispatch`, `dispatchSync` and `chain`. Nothing in
`packages/queue` mentions after-response at all; the `onAfterResponse` hooks in
the repository belong to http, log and lens.

**Done when** a job can be dispatched after the response, it runs in the same
process, a failure there is recorded rather than crashing the response that has
already gone, and tests can assert it.

### Dispatching a thousand jobs is a thousand round trips

`Bus::bulk()` hands a whole array to the driver in one call. Elvel has no such
path: `PendingBatch.dispatch()` loops and `await`s `dispatch()` per job, so a
batch of a thousand rows is a thousand inserts, one at a time, inside the
request that created it.

**Done when** the driver contract takes many payloads at once, the database and
Redis drivers implement it as one statement and one pipeline, and batch dispatch
uses it.

### A batch cannot grow

`$batch->add($jobs)` is how upstream fans work out progressively — the first job
discovers the work and adds it to the batch it is already in, and the totals
move with it. `Batch` has no `add`, and `BatchRepository` has no way to raise
`totalJobs` and `pendingJobs` on a row that already exists.

Without it a batch has to know its full size before the first job runs, which
rules out exactly the case batching is best at.

**Done when** `add()` exists, the counts move atomically, and a batch that is
already finished refuses to be added to.

### A chain has no failure handler and cannot be changed from inside

Three pieces, all absent:

- `Bus::chain([...])->catch(...)` — when a link fails the rest simply never run
  and only that job's own `failed()` fires; nothing is told the chain died.
- `$this->prependToChain()` / `appendToChain()` — a running job cannot put work
  in front of or behind the remaining links.
- `ChainedBatch` — a batch cannot be a link in a chain. The reverse works: a
  chain can be an entry in a batch (`BatchEntry`).

`QueueManager.chain()` is `dispatch(first, { chain: rest })` and
`JobRunner.dispatchChain()` queues the next link. That is the whole
implementation.

**Done when** a chain carries a failure callback, a job can extend its own
chain, and a batch can stand as a link.

### A batch only announces that it was dispatched

Upstream dispatches four: `BatchDispatched`, `BatchStarted`, `BatchFinished`,
`BatchCanceled`. Elvel emits `queue.batch.dispatched` from
`packages/queue/src/bus.ts` and nothing else.

The application-facing case is covered better than by events — `onFinished`
takes a job class. What is not covered is anything watching from outside:
Lens files the batch when it is created and can never show that it finished,
failed, or was cancelled, and neither can a metrics listener.

**Done when** started, finished and cancelled are dispatched with the batch id
and counts, and the Lens batch entry is amended when they arrive.

### The fake cannot see chains or batches

`QueueFake` asserts `assertPushed`, `assertNotPushed`, `assertPushedTimes`,
`assertPushedOn`, `assertPushedWithDelay`, `assertNothingPushed`, `assertCount`.

Upstream's bus fake also carries `assertChained`, `assertDispatchedWithoutChain`,
`assertNothingChained`, `assertBatched`, `assertBatchCount`,
`assertNothingBatched` and `assertDispatchedSync`. None have an equivalent, so
"this controller dispatches these three jobs *in order*" and "this import is
batched" are both untestable — and those are the two things worth asserting
about work that is not run inline.

**Done when** a chain and a batch are recorded by the fake with their contents,
and both can be asserted on.

---

## Cache

`Repository` is the closest match of anything measured so far: `has`, `missing`,
`get`, `many`, `pull`, `put`, `putMany`, `add`, `increment`, `decrement`,
`forever`, `remember`, `rememberForever`, `sear`, `flexible`, `touch`,
`withoutOverlapping`, `funnel`, `forget`, `flush`, the typed readers (`string`,
`integer`, `float`, `boolean`, `array`), tags, and the PSR-16 spellings. `Lock`
carries the owner token, `block()` measures against the clock rather than
counting attempts, and `flexible()` refreshes behind a lock after the response.

### Four stores

`array`, `file`, `database`, `redis`, plus the `memo` wrapper and `extend()`.
Upstream also ships `null`, `memcached` and `dynamodb`.

`null` is the one that is missed daily: there is no way to say "cache nothing"
in an environment, and `CACHE_STORE=null` today is a boot error. Proving a page
still works with the cache off means editing the config.

**Done when** `null` is a store, and memcached and DynamoDB are either drivers
or a documented `extend()` recipe.

### A store that is down takes the application with it

Upstream added `FailoverStore`: a list of stores tried in order, falling to
the next when one throws, dispatching `CacheFailedOver` as it goes. Nothing
equivalent exists here — `CacheManager.driverFor()` builds exactly one store per
name, and a Redis that stops answering turns every cached read into an
exception.

For a cache — the one part of a system whose entire premise is that losing it
should cost latency, not correctness — that is the wrong failure mode.

**Done when** a store can be configured as a chain, a failure falls through to
the next, and the fall-through is announced rather than silent.

### A write that fails says nothing

`Repository.put()` ends:

```ts
const stored = await this.store.put(key, value, seconds)
if (stored) this.event('cache.written', { key, value, seconds })

return stored
```

When the store returns `false` — Redis refusing the write, the file store out of
disk — no event is emitted, nothing is logged, and the caller gets a boolean
that almost nobody checks. The cache silently stops caching and the only symptom
is that the application gets slower.

Elvel emits five cache events: `hit`, `missed`, `written`, `forgotten`,
`flushed`. Upstream emits eighteen, and the two families missing here are exactly
the ones that are not decorative:

- the failures — `KeyWriteFailed`, `KeyForgetFailed`, `CacheFlushFailed`,
  `CacheLocksFlushFailed`
- the "about to" — `RetrievingKey`, `RetrievingManyKeys`, `WritingKey`,
  `WritingManyKeys`, `ForgettingKey`, `CacheFlushing` — which are what a
  listener needs to observe or intercept a read before the store is touched

**Done when** a failed write, forget or flush dispatches an event, Lens shows it
as a finding, and the before-events exist for the six operations that have them
in upstream.

### Locks cannot be flushed or inspected

Missing: `Cache::flushLocks()` and `supportsFlushingLocks()` on the repository,
and `isLocked()` and `forceRelease()` on `Lock`. The abstract `Lock` has
`acquire`, `release`, `get`, `block`, `refresh`, `owner`, `isOwnedBy`,
`isOwnedByCurrentProcess` and `betweenBlockedAttemptsSleepFor`.

The gap shows up after a crash: a worker killed mid-`block()` leaves a lock row
behind, and the only ways out today are waiting for the TTL or deleting the key
by hand. `isLocked()` is one line on top of `currentOwner()`.

**Done when** a lock can be inspected and force-released, and every lock in a
store can be flushed with the events upstream dispatches around it.

### A named limiter cannot shape its own refusal

`LimiterRegistry` in `packages/http/src/throttle.ts` covers
`RateLimiter::for(...)`. What `Limit` cannot do is say what happens when it is
hit: Upstream's `Limit::response(...)` gives the limiter its own 429 body,
`Limit::after(...)` its own callback. Elvel throws a fixed
`TooManyRequestsError('Too Many Attempts.')` for every limiter in the
application.

Also absent from `Limit`: `perMinutes(n)` and `fallbackKey`.

**Done when** a limiter can supply the response its refusal renders, and
`perMinutes` exists.

### `rememberWithWarmth()` is absent

Upstream's `remember()` is now one line on top of it, and it returns
`[value, wasWarm]` — whether the value came from the store or was just computed.
That boolean is what a caller logs, counts, or uses to decide whether to warm
something else. Elvel's `remember()` throws it away.

**Done when** the warm flag is available without a second `has()` call racing
the read.

---

## Collections

`Collection` carries 98 methods against upstream's 178, and the ones it has are
faithful — `sliding`, `splitIn`, `duplicatesStrict`, `hasSole`, `firstOrFail`,
`skipUntil`, `crossJoin`, `median`, `multiply`, `percentage`'s neighbours. Four
things are missing, and the first is structural rather than a list of names.

### The collection is a list, not an ordered map

```ts
export class Collection<T> implements Iterable<T> {
  constructor(private readonly items: T[] = []) {}
```

A `Illuminate\Support\Collection` is an ordered map, and about a third of its
API is about the keys. Here there are no keys, and the consequence is not that
some methods are missing — it is that **the chain breaks**:

```ts
keyBy<K extends string | number>(key: (item: T) => K): Record<K, T>
mapWithKeys<K, V>(callback: (item: T, index: number) => [K, V]): Record<K, V>
```

Both return a plain object. `collect(users).keyBy(u => u.id)` ends the
collection there and hands back something with no `map`, no `filter`, no
`each` — so the caller drops to bare objects for the rest of the pipeline,
which is the exact thing the class's own comment says it exists to prevent.

Absent with the keys: `keys`, `get`, `put`, `has`, `hasAny`, `getOrPut`,
`forget`, `pull`, `flip`, `union`, `combine`, `replace`, `replaceRecursive`,
`mergeRecursive`, `diffKeys`, `diffAssoc`, `intersectByKeys`, `intersectAssoc`,
`sortKeys`, `sortKeysDesc`, `sortKeysUsing`, `mapToGroups`, `mapToDictionary`,
`dot`, `undot`, `prependKeysWith`.

**Done when** a collection can hold keys — either by holding a `Map` or by a
second keyed type that the keyed operations return — so that `keyBy` answers
with something that can still be mapped.

### Nothing is lazy

`LazyCollection` has no counterpart. The database does stream —
`ModelBuilder.lazy()` is an `async *` generator walking by key — but it yields a
bare `AsyncGenerator<M>`, so the moment you want to `filter`, `map`, `take` or
`chunk` what it produces you either write the loop by hand or call `.get()` and
materialise the lot.

`take(5)` over a million-row table should read five rows. Today the streaming
half exists and the operator half does not, which means the laziness is only
available to code that does its own `for await`.

**Done when** `lazy()` returns something with the collection operators on it,
evaluated per item, plus `takeUntilTimeout`, `tapEach` and `remember`.

### Filters and shapers that are missing

Not key-related, and each is a real method somebody reaches for:

`whereBetween`, `whereNotBetween`, `whereInstanceOf`, `whereStrict`,
`whereInStrict`, `whereNotInStrict`, `forPage`, `mapInto`, `mapSpread`,
`eachSpread`, `reduceSpread`, `reduceWithKeys`, `pipeInto`, `pipeThrough`,
`splice`, `transform`, `unshift`, `ensure`, `percentage`, `mode`, `chunkBy`,
`collapseWithKeys`, `value`, `lazy`, `fromJson`, `toJson`, `toPrettyJson`,
`dd`, `dump`.

**Done when** each exists or is deleted from this row with a reason.

### `Arr` is 33 of 59

Present: `collapse`, `crossJoin`, `divide`, `dot`, `undot`, `except`, `only`,
`first`, `last`, `flatten`, `forget`, `get`, `set`, `has`, `hasAny`, `isAssoc`,
`isList`, `keyBy`, `mapWithKeys`, `mapSpread`, `partition`, `pluck`, `prepend`,
`pull`, `query`, `random`, `reject`, `shuffle`, `sole`, `sortBy`, `unique`,
`wrap`, `groupBy`.

Missing: `add`, `exists`, `hasAll`, `join`, `prependKeysWith`, `select`,
`sortRecursive`, `sortRecursiveDesc`, `where`, `whereNotNull`, `take`, `push`,
`map`, `some`, `every`, `onlyValues`, `exceptValues`, `accessible`,
`arrayable`, `from`, and the typed readers `string`, `integer`, `float`,
`boolean`, `array`.

The typed readers are the ones that matter beyond convenience: a JSON body is
`unknown` at runtime whatever TypeScript believes at compile time, and
`Arr.integer(body, 'page')` is the difference between a validated read and a
cast that lies.

**Done when** the list above is empty or each entry has a reason for staying
out. `toCssClasses` and `toCssStyles` are **not** on it — they are `classes()`
and `styles()` in `@elvel/view`.

---

## Console

The signature parser, the generator commands, `promptForMissing`, command
suggestion on a typo, `--isolated` with a per-command `isolatable` opt-in, and
prompts through `@clack/prompts` are all present. `Output.pairs()` is
`twoColumnDetail`, `tag()` is the `INFO`/`ERROR` label.

### There are no verbosity levels

No `-v`, `-vv`, `-vvv` anywhere in `packages/console`. `line()`, `info()` and
the rest take a message and nothing else, there is no `isVerbose()`, and
`call()` has no `callSilent()` counterpart — a command that runs another cannot
suppress its output.

Every command therefore has to choose once, for everybody: print the detail and
be noisy in CI, or stay quiet and give a person debugging nothing to work with.
Upstream's answer is one argument on every write.

**Done when** `-v/-vv/-vvv` are parsed, every output method takes a minimum
verbosity, `isVerbose()` exists, and `call()` can run a command silently.

### A spinner, but no progress bar

`Output.spinner()` wraps Clack's, which is indeterminate. There is no
`withProgressBar($items)` and no bar with a known total, so a command importing
fifty thousand rows can say it is working and cannot say how far it has got.
The only "progress" in the repository is `Batch.progress`, which is a percentage
on a queue batch and nothing to do with the terminal.

**Done when** a command can wrap an iterable in a bar that shows position,
total, and estimated remaining, and degrades to a line per N items when the
output is not a terminal.

### Signals are handled three times, by hand, and not by commands

Upstream puts `trap()` and `untrap()` on the command. Here, `SIGINT`/`SIGTERM`
are wired with raw `process.on` in `commands/dev.ts`, `queue/console/queue-work.ts`
and `scheduler/console/schedule-work.ts` — three copies, and nothing an
application's own long-running command can reach.

Getting shutdown right is exactly the thing that should be written once: finish
the unit of work, stop accepting new work, exit with the right code.

**Done when** `Command` exposes signal trapping, the three existing handlers use
it, and a trapped command still exits non-zero on the second interrupt.

### Only migrations are protected from production

`confirmInProduction()` exists — on `MigrationCommand`, in
`packages/database/src/console/base.ts`. Upstream's `ConfirmableTrait` is
available to any command, and `Prohibitable` goes further: `Command::prohibit()`
takes a destructive command out of the application entirely, which is how
`db:wipe` and `migrate:fresh` are kept off production hosts.

So today `queue:clear` and anything an application writes have to reimplement
the guard, and nothing can be prohibited outright.

**Done when** the confirmation lives on `Command` with the `--force` opt-out,
and a command can be prohibited.

### A command cannot be hidden or aliased

`Command` declares `signature`, `description` and `isolatable`. Upstream carries
`aliases`, `hidden`, `usage` and `help` as attributes.

`hidden` is what keeps internal plumbing — the command a scheduler invokes for
its own bookkeeping — out of the list a person reads. `aliases` is how a
renamed command keeps working.

**Done when** both are statics on `Command` and `elvel list` honours them.

### Three output components are missing

- `task('Migrating', fn)` — runs the callback and prints `✓`/`✗` with the time
  taken. The single most-used one, and what makes a long command legible.
- `bulletList`
- `alert` — the boxed warning, distinct from the `tag` label
- `anticipate` / `askWithCompletion` — a prompt that suggests as you type

**Done when** each exists on `Output` and behaves when stdout is not a terminal.

---

## Container

The whole container is five methods:

```ts
bind(key, factory)      singleton(key, factory)   instance(key, value)
make(key)               bound(key)
```

backed by two `Map`s. Upstream's has fifty-odd. Most of the difference is not
convenience — each row below is a thing packages currently cannot do to each
other, which is what a container is for.

Two of upstream's pillars are **not** listed as gaps and are recorded at the
bottom: autowiring (`build()`) and method injection (`call()`) both need runtime
type information, and TypeScript erases types.

### There are no scoped bindings

`scoped()` and `scopedIf()` resolve once per request and are thrown away after
it. Elvel has the primitive — `requestSlot()` in
`packages/core/src/request-context.ts` — and no container-level way to use it,
so every package that wants a per-request instance builds its own slot and its
own lifecycle. `AuthManager` does exactly that, and its comment explains the
whole mechanism because there was nowhere shared to put it.

**Done when** `scoped()` exists, the instance is discarded when the request
ends, and `AuthManager` uses it instead of hand-rolling one.

### A binding cannot be decorated, or defaulted

Four missing pieces of the same idea — how two packages share one key:

- `extend(key, fn)` wraps what is already bound. Without it a package that wants
  to decorate the logger has to re-bind it, throwing away whatever anybody else
  had done.
- `bindIf` / `singletonIf` bind only when nothing is bound — how a package
  supplies a default the application may already have overridden. Today every
  provider must write `if (!app.bound('x'))` by hand, and several do.
- `rebinding` / `refresh` notify a holder when a key is re-bound. Nothing here
  can react, so an object that captured a dependency at boot keeps the old one
  for ever.

**Done when** all four exist and the `if (!bound(...))` checks in the providers
are replaced by `bindIf`.

### There are no tags

`tag(['a','b'], 'reports')` then `tagged('reports')` resolves the group. It is
how a framework collects things it cannot name in advance: every notification
channel, every health check, every Lens watcher.

Lens registers its watchers through its own list; the queue registers job
classes through its own registry; broadcasting keeps its own channel map. Three
registries doing what one container feature does.

**Done when** `tag`/`tagged` exist and at least one of those registries is
built on them.

### There is no contextual binding

`when(ReportMailer::class)->needs(Transport::class)->give(SesTransport::class)`.
Absent, and nothing approximates it: a key resolves to one thing for the whole
application.

The case is ordinary — one consumer of an interface needs a different
implementation from everyone else. Today the only answer is a second key and a
consumer that knows the name, which is the coupling the container exists to
remove.

**Done when** a binding can differ by the consumer asking for it.

### Nothing can hook resolution

`resolving`, `afterResolving`, `beforeResolving`. This is how a package
configures instances of a type it does not own — set a default timeout on every
HTTP client the application builds, tag every model with the current request.

**Done when** callbacks can run before and after a key resolves, and they run
for `instance()` bindings too.

### The container cannot be reset or inspected

No `flush`, `forgetInstance`, `forgetInstances`, `forgetScopedInstances`,
`resolved`, `isShared`, or `getBindings`.

Two costs. A test that wants a clean container has to build a whole new
`Application`, and the dev server's reload cannot drop a stale singleton.
And `elvel about` cannot list what is bound, which is the first thing anybody
asks when a binding resolves to the wrong thing.

**Done when** the container can be flushed, one key can be forgotten, and the
bindings can be listed.

---

## Cookie

`CookieBag`, `CookieJar` and `cookiePlugin` cover upstream's `EncryptCookies` and
`AddQueuedCookiesToResponse` faithfully — an `except` list for cookies something
else must read, `Set-Cookie` appended rather than assigned so the session
plugin's header survives, a cookie that fails to decrypt read as absent so a key
rotation resets a preference instead of throwing, and the header parsed once per
request rather than once per plugin.

### Cookies have no configurable defaults, and `Secure` is off

`CookieJar.serialize()` decides every attribute:

```ts
parts.push(`Path=${options.path ?? '/'}`)
if (options.domain) parts.push(`Domain=${options.domain}`)
if (options.httpOnly !== false) parts.push('HttpOnly')
if (options.secure) parts.push('Secure')
parts.push(`SameSite=${capitalise(options.sameSite ?? 'lax')}`)
```

`secure` is only ever set when the call site passes it, and there is nothing to
set it from: `config/session.ts` has `secure`, and the provider applies it to
**the session cookie only**. `config/http.ts` has no cookie block at all — the
only cookie config is `cookies.except`.

So an application on HTTPS that queues a preference, a consent flag or a
remember-me marker sends it without `Secure` unless every call site remembers,
and no `domain` can be set once for a deployment that spans subdomains.
Upstream's answer is `CookieJar::setDefaultPathAndDomain($path, $domain, $secure,
$sameSite)`, called from the session config at boot.

**Done when** path, domain, secure and sameSite have configured defaults applied
by the jar, `secure` follows `isProduction()` as the session cookie already
does, and a call site can still override.

---

## Database

The largest component, and the one with the most already built. Every relation
type upstream has is here — including `HasOneOfMany` and a `MorphToManyThrough`
Upstream does not. The migrator has `--pretend`, `--step`, `--isolated`,
squashing, per-environment `shouldRun` and transactional migrations. The console
set is complete and then some (`make:cast`, `make:observer`, `make:scope`).
`Blueprint` is 110 methods against upstream's 126 and folds in the fluent foreign
key modifiers. Deadlocks are retried. Read/write splitting and sticky
connections work.

### A failed query throws the driver's error, naked

`packages/database/src/connection/bun-sql.ts` catches only to retry a deadlock.
Nothing wraps a driver error, and the only exception class the whole package
exports is `ModelNotFoundError`.

Upstream wraps every failure in `QueryException`, which carries the SQL and the
bindings and puts the statement in the message. Here a bad column name arrives
as whatever Bun's SQL client said, with no statement attached — so the log line,
and the Lens exception entry, name a syntax error and not the query.

Worse is what is missing beneath it: **`UniqueConstraintViolationException`**.
Without it a duplicate key cannot be told from any other failure except by
matching the driver's message, which differs across SQLite, MySQL and Postgres.
That single class is what `createOrFirst()` is built on, and it is why every
race between two requests inserting the same row has to be solved by hand here.

**Done when** driver errors are wrapped with the SQL and bindings, a unique
violation is its own type across all three dialects, and `createOrFirst()`
exists on top of it.

### `get()` returns a plain collection

```ts
async get(): Promise<Collection<M>> {
  ...
  return new Collection(models)
}
```

That is `@elvel/support`'s `Collection`, not an Eloquent one. So the methods
that only make sense over models are all absent: `load()` and `loadMissing()`
to eager-load after the fact, `modelKeys()`, `fresh()`, `toQuery()`,
`makeVisible()`/`makeHidden()`, `append()`, `except()`/`only()` by key,
and a `diff` that compares by key rather than by identity.

`load()` is the one that costs: having fetched a set of models and then found
you need a relation, the answer here is a second query per model — the N+1 the
eager loader exists to prevent.

**Done when** the model builder returns a collection that can load relations,
and `@elvel/support`'s `Collection` stays what it is.

### Eloquent has no strict mode

Absent: `preventLazyLoading`, `preventSilentlyDiscardingAttributes`,
`preventAccessingMissingAttributes`, and the `Model::shouldBeStrict()` that
turns on all three.

`preventLazyLoading` is the best N+1 defence there is: in development a relation
accessed without being eager-loaded **throws**, naming the model and the
relation, at the moment the mistake is made. Lens's `repeated` finding exists to
report N+1 after the fact; this prevents it.

`preventSilentlyDiscardingAttributes` catches the other everyday bug — a `fill()`
with a key that is not fillable, which today is dropped without a word.

**Done when** all three exist, are on by default outside production, and the
Lens N+1 finding says which of the two you are relying on.

### Nothing fires when a model is read

`ModelLifecycleEvent` lists eight moments — `saving`, `saved`, `creating`,
`created`, `updating`, `updated`, `deleting`, `deleted` — and no read. `hydrate()`
sets the attributes and returns:

```ts
static hydrate<T extends typeof Model>(this: T, row: Row): InstanceType<T> {
  const model = new this() as InstanceType<T>
  model.attributes = { ...row }
  model.syncOriginal()
  model.exists = true
  return model            // nothing dispatched
}
```

Eloquent's `retrieved` is what Telescope counts to answer "this request
hydrated 1,240 models", the number that exposes a query pulling a whole table.
`ModelWatcher` says so in its own comment and cannot do it.

Adding the event is not one line: `fireEvent()` is `async` and `hydrate()` is
synchronous, so an event here makes `hydrate()` async and every caller with it —
`get()`, `first()`, eager loading, pivots. PHP never had to decide this.

**Done when** hydration is observable, whether by an event or by a counter the
recorder reads at the end of the request, and Lens shows the count.

### Factories cannot build a graph

`Factory` has `count`, `state`, `with`, `raw`, `make`, `create`, `createOne`.
That is the whole class.

Upstream's has `has()`, `for()`, `hasAttached()` and `withoutParents` — creating a
user with three posts each with five comments in one expression — plus
`sequence()` and `crossJoinSequence()` to cycle values across a batch,
`afterMaking`/`afterCreating` hooks, `recycle()` to share one parent across a
graph, `createMany`, `makeOne`, `createQuietly`, and `connection()`.

There is also no `Model::factory()`; a factory is constructed by hand.

Seeding anything with relations therefore means writing the loops, which is what
factories are for.

**Done when** a factory can declare its relations, sequences exist, the two
hooks run, and `Model.factory()` resolves the class.

### Six cast types are missing

Present: `int`, `float`, `boolean`, `string`, `json`, `object`, `array`, `date`,
`datetime`, `timestamp`, `encrypted`, `encrypted:json`, plus custom
`CastsAttributes` classes and blind-index columns, which upstream has no
equivalent of.

Missing: **enum** (`'status' => Status`), **`decimal:2`**, `immutable_date`,
`immutable_datetime`, `collection`, and `hashed`.

The enum cast is the one felt daily — a status column read as a bare string
throws away the one thing TypeScript could have checked. `decimal` is the one
that costs money: a money column read as a float is a rounding bug waiting for
a large enough number.

**Done when** each exists, and the enum cast narrows the attribute's type.

### The schema cannot be inspected

`Schema` has 15 methods against upstream's 44. Missing: `getTables`, `getViews`,
`getColumns` (only `getColumnListing`, which is names), `getIndexes`,
`getForeignKeys`, `getColumnType`, `getTypes`, `getSchemas`, `hasView`,
`hasColumns`, `hasForeignKey`, `dropAllTables`, `dropAllViews`, `createDatabase`,
`dropDatabaseIfExists`, `whenTableHasColumn` and its three siblings,
`ensureExtensionExists`.

It is not that nobody needs them — `db:show` writes the query itself:

```ts
const sql =
  dialect === 'sqlite'
    ? "select name from sqlite_master where type = 'table' ..."
    : dialect === 'postgres'
      ? 'select tablename as name from pg_catalog.pg_tables ...'
      : 'select table_name as name from information_schema.tables ...'
```

Three dialects of introspection SQL, inline, in a console command, where no
application and no other command can reach it. `db:table` and `model:show` each
carry their own.

**Done when** the introspection lives on the schema builder per grammar, and the
commands read it from there.

### Blueprint cannot describe a spatial or an indexed vector column

Missing from `Blueprint`: `geometry`, `geography`, `spatialIndex`,
`dropSpatialIndex`; `vectorIndex` and `dropVectorIndex` — `vector` exists, so a
pgvector column can be created and never indexed, which is the same as not
having it; `engine`, `charset` and table-level `collation`; `temporary`;
`computed` (generated columns); `set`; `tsvector`; `rawColumn` and `rawIndex`;
`foreignIdFor`/`foreignUuidFor`/`foreignUlidFor`; and
`dropConstrainedForeignId`, which is the one every `down()` wants.

**Done when** each exists or is struck off with a reason.

### Query builder: seven families missing

136 methods against upstream's 232. Setting aside internals and pagination
(recorded under Pagination), what is left:

- **multi-column search** — `whereAll`, `whereAny`, `whereNone` and their `or`
  forms: one search box against five columns, which is otherwise a nested
  closure every time
- **JSON** — `whereJsonContainsKey`, `whereJsonDoesntContain`,
  `whereJsonOverlaps`, `whereJsonDoesntOverlap` and their negatives.
  `whereJsonContains` and `whereJsonLength` are there
- **`whereNotLike`** — `whereLike` is there and its negative is not
- **raw and sub-select** — `orderByRaw`, `fromRaw`, `selectSub`,
  `selectExpression`, `rawValue`
- **joins** — `joinLateral`, `leftJoinLateral`, `joinWhere`, `leftJoinWhere`,
  `rightJoinWhere`, `rightJoinSub`, `straightJoin`
- **column comparisons** — `whereBetweenColumns`, `whereNotBetweenColumns`,
  `whereRowValues`, `whereNullSafeEquals`, `whereValueBetween`
- **operations** — `updateFrom`, `insertOrIgnoreUsing`, `insertOrIgnoreReturning`,
  `soleValue`, `groupLimit`, `timeout`, index hints (`useIndex`, `forceIndex`,
  `ignoreIndex`), and the `beforeQuery`/`afterQuery` hooks

Plus the debugging ones: `toRawSql`, `dumpRawSql`, `dd`. `toRawSql` — the
statement with its bindings inlined, ready to paste into a client — is the one
that gets used most, and Lens's query panel would render it instead of the
placeholder form.

Upstream's vector search (`whereVectorSimilarTo`, `orderByVectorDistance`,
`selectVectorDistance`) is absent too, and pairs with the missing
`vectorIndex` above.

**Done when** each family exists or is struck off with a reason.

### Model: eight methods, and no UUID keys

`firstOrNew`, `createOrFirst`, `loadMissing`, `loadCount`, `withOnly`,
`without`, and model-level `upsert` (the query builder has it) are absent.

So is `HasUuids`/`HasUlids` — a model whose primary key is a UUID generated on
create, with the string key type set correctly for the route binding and the
`where` clause. `Blueprint.uuid()` and `.ulid()` exist, so the column can be
made and the model cannot use it as its key without doing the generation by
hand.

`BroadcastsEvents` is missing as well: a model whose changes broadcast to a
channel, which with the websocket server already built is a short bridge.

**Done when** the seven methods exist, a model can declare a UUID or ULID key,
and a model can broadcast its own events.

---

## Events

`listen`, `subscribe`, `dispatch`, `until`, `push`/`flush`, `forget`, wildcards,
queued listeners with `shouldQueue`/`delay`/`tries`/`backoff`, listeners that
wait for the transaction to commit, `event:list`, `EventFake` with an `except`
list, and a real `NullDispatcher`.

### The fake cannot assert on what was dispatched

```ts
assertDispatched(event: EventKey, times?: number): void
```

The event's name and a count. Upstream's takes a callback —
`assertDispatched(OrderShipped::class, fn ($e) => $e->order->id === 1)` — which
is the difference between "an order shipped" and "*this* order shipped". With
several of the same event in one test, the current assertion cannot tell them
apart.

`assertListening(event, listener)` is missing too: whether a provider actually
registered its listener, which is what breaks silently when a provider is
reordered.

**Done when** the payload can be inspected by a callback, and a registration can
be asserted.

---

## Filesystem

The `Disk` contract carries 32 of upstream's methods, the `memory` disk is
`Storage::fake()` with `assertExists`, `assertMissing`, `assertCount`,
`assertDirectoryEmpty` and an `assertContents` upstream has no equivalent of, and
`fileResponse()` gets `Content-Disposition` right for a non-ASCII filename under
RFC 6266 — stripping quotes rather than escaping them, because a filename that
closes the quoted string early injects a header parameter.

### There is no `writeStream`

`readStream` exists; its opposite does not. Every write goes through
`put(path, contents)`, so a file is fully in memory before it reaches the disk.

An upload of a 2 GB video costs 2 GB of the process, on the S3 disk as much as
the local one. This is the single limit that decides whether an application can
accept large files at all, and it is not a configuration — there is no path
through the contract that streams.

**Done when** `writeStream(path, stream)` is on the contract, the local disk
pipes to a file handle, and the S3 disk uses a multipart upload.

### A file is always sent whole

`fileResponse()` reads the stream and returns it. No `Accept-Ranges`, no
`Range` parsing, no `206` — nowhere in `packages/storage` or `packages/http`.

So a video or audio file served from a disk cannot be seeked: the browser asks
for a byte range, gets the whole file with a `200`, and starts again from the
beginning. An interrupted download cannot be resumed either. Upstream's
`Storage::serve()` handles both.

**Done when** a range request is answered with `206` and the requested slice,
`Accept-Ranges` is advertised, and an unsatisfiable range is a `416`.

### A remote disk is read remotely, every time

Upstream added `ReadThroughFilesystem`: a local disk in front of a remote one,
so a file fetched from S3 is served from local disk the next time and the
round trip is paid once.

Nothing like it here. An application serving user uploads from S3 pays the
latency on every read, and the only workaround is to write the caching by hand
around every call.

**Done when** a disk can be configured with another disk in front of it, with a
TTL and a size bound.

### There is no file API outside a disk

`Illuminate\Filesystem\Filesystem` — the `File` facade — is what code reaches
for when the file is not on a configured disk: a generator writing a stub, a
command reading a fixture, a deploy script. `glob`, `ensureDirectoryExists`,
`cleanDirectory`, `copyDirectory`, `lines`, `replaceInFile`, `hash`,
`sharedGet`, `isWritable`, `guessExtension`.

Elvel has none of it, so every command that touches a file uses `node:fs`
directly — `packages/console/src/generator.ts` and the migration generator both
do — and each re-decides what "make the directory if it is missing" means.

**Done when** the utilities exist in one place and the generators use them.

---

## Foundation

Maintenance mode with a bypass cookie, deferred callbacks flushed after the
response, trusted proxies with per-header control, the security headers, CSRF,
CORS, and a `middleware:list` command upstream has no equivalent of.

### Input is not normalised

`TrimStrings` and `ConvertEmptyStringsToNull` are in every upstream application's
default stack. Neither exists here.

Without the first, a form field submitted with a trailing space is stored with
it, and `where('email', $input)` misses the row. Without the second, an empty
text input arrives as `''` rather than `null`, so a `nullable` column gets an
empty string and `nullable` validation passes something the schema meant to be
absent.

**Done when** both exist as middleware, are in the scaffold's default stack, and
can be excepted per field — a password must never be trimmed.

### Precognition is missing

`HandlePrecognitiveRequests` runs a request's validation and middleware and
stops before the handler, answering `204` with the errors. It is what makes
live, per-field validation work in an Inertia or Vue form without duplicating
the rules in JavaScript.

Elvel has form requests and the validator; nothing wires them into the
precognitive protocol, so a front end wanting live validation posts the whole
form and hopes, or the rules are written twice.

**Done when** `Precognition` and `Precognition-Validate-Only` are honoured, the
handler is not run, and the scaffolded kits use it.

### The application builder configures five things, not nine

`withProviders`, `withConfig`, `withRoutes`, `withRouting`, `withConsole`.

Upstream's `ApplicationBuilder` also has `withMiddleware` — the one that matters,
because it is where an application appends to, removes from, or reorders the
global stack, and today that means reaching into providers. Then
`withExceptions` for reporting and rendering rules, `withSchedule`, and
`withEvents`.

Exception handling in particular has no builder entry: `ExceptionHandler` is
bound in the container, so customising how one exception renders means replacing
the binding rather than declaring a rule.

**Done when** the builder can shape the middleware stack and register exception
reporting and rendering callbacks.

---

## Http

Route model binding is here and complete — `BindingRegistry` with implicit model
resolution, scoped child bindings, `withTrashed`, and hand-written resolvers for
anything that is not a model. So are API resources (`JsonResource`,
`ResourceCollection`, a `MISSING` sentinel), form requests with
`prepareForValidation`/`passedValidation`/`withValidator`, signed URLs, the
error bag and old input, CSRF, CORS, method override, the security headers, the
session with four drivers, and named rate limiters.

### An uploaded file cannot be stored

Validation handles uploads well — `file`, `image`, `mimes`, `mimetypes`,
`dimensions`, `extensions` all work against the Web `File` object, which is the
right thing to validate.

What is missing is everything after: `store('avatars')`, `storeAs`,
`storePublicly`, `hashName()`, and the original name and extension helpers.
Today an upload is put on a disk by reading the whole `File` into memory and
calling `put()` with a name the application invents — and because there is no
`writeStream` either (recorded under Filesystem), the memory cost is the file
size, per concurrent upload.

Getting the name right is not incidental: a file stored under its client-supplied
name is a path-traversal and an overwrite waiting to happen, which is why
`hashName()` exists.

**Done when** an uploaded file can be streamed to a disk in one call with a
generated name, and the original name and extension are read from it safely.

### There is no request input API

Inside a `FormRequest` there is `input`, `has`, `merge`, `safe` and `validated`.
Outside one, a handler holds the Web `Request` and whatever Elysia parsed.

Absent everywhere: `input('a.b')` with dot access and a default, `only`,
`except`, `filled`, `missing`, `whenFilled`, `whenHas`, `hasAny`,
`mergeIfMissing`, `collect`, and the typed readers `boolean`, `integer`,
`float`, `string`, `date`, `enum`.

`boolean()` is the one every form needs — an unchecked checkbox is absent, a
checked one is `"on"`, and `"0"` is false — and every application writes that
coercion again. `date()` and `enum()` are the same story with worse failure
modes.

This is the same absence as `Config`'s typed readers and `Arr`'s, in the place
where the data is least trustworthy.

**Done when** the readers exist against the parsed body and query, dot access
works, and a form request exposes the same set.

### Nothing supports a conditional GET

No `ETag`, no `Last-Modified`, no `If-None-Match`, no `304` — the strings do not
appear in `packages/http`. Upstream's `CheckResponseForModifications` is in the
default stack.

Every response is therefore sent in full every time, including the ones that
have not changed since the browser last asked. For an API served to a mobile
client, or a page behind a CDN, that is the cheapest saving there is and it is
not available.

**Done when** a response can carry an `ETag`, a matching `If-None-Match` answers
`304` with no body, and `Last-Modified`/`If-Modified-Since` do the same.

### Content negotiation stops at "does this want JSON"

`expectsJson()` is all of `negotiation.ts`. Missing: `accepts(types)`,
`prefers(types)`, `acceptsHtml`, `acceptsAnyContentType`,
`getAcceptableContentTypes`.

One endpoint that answers HTML to a browser, JSON to `fetch`, and CSV to
`Accept: text/csv` is ordinary, and today it means parsing the `Accept` header
by hand — including the `q=` weights, which is where hand-parsing goes wrong.

**Done when** `accepts` and `prefers` exist and honour quality values.

---

## Image

Two halves, and the split is right: `probe()` reads format and dimensions out of
the bytes in pure TypeScript for eight formats with no dependency and no driver,
because the extension and the `Content-Type` a client sent are claims and the
header is the file. Transforming looks for a backend — `sharp`, ImageMagick,
`sips` — rather than assuming one, and a driver that cannot perform a queued
step says so instead of skipping it. the upstream component is new in 13 and
Elvel matches most of it.

### An image cannot be read from or written to a disk

```ts
async store(path: string): Promise<Uint8Array> {
  const bytes = await this.toBytes()
  await Bun.write(path, bytes)
  return bytes
}
```

`Bun.write` — the local filesystem, and only that. Upstream's `Image` has
`store`, `storeAs`, `storePublicly`, `storePubliclyAs` and `hashName` against a
configured disk, and reads with `fromStorage`, `fromUpload` and `fromUrl`.

So the ordinary path — accept an upload, resize it, put it on S3 — is manual at
both ends: read the `File` yourself, and `toBytes()` then `put()` yourself,
buffering the image twice and naming it by hand.

**Done when** an image can be built from an upload or a disk and written back to
one, with a generated name.

### `optimize()` and `dominantColor()` are absent

`optimize()` re-encodes at the best quality the format allows without changing
the pixels — the one call that makes an upload pipeline pay for itself.
`dominantColor()` is what a placeholder background is drawn from while the image
loads.

Both are one delegation to a driver that already exists.

**Done when** both exist and a driver that cannot do either says so rather than
returning the original.

---

## Log

Nine drivers — `console`, `json`, `single`, `daily` with retention, `stack`,
`errorlog`, `slack`, `memory`, `null` — all eight PSR levels, `channel`,
`stack`, `build`, `extend`, `shareContext`, `withContext`, `withoutContext`,
`forgetChannel`, a `MessageLogged` event, deprecation logging, and a `log:tail`
command upstream has no equivalent of.

### There is no `Context`

`Illuminate\Log\Context` is a repository of key/values that every log line in
the request carries — and, crucially, that is **dehydrated into a queued job's
payload and rehydrated in the worker**, so the job's log lines carry the request
id of the request that dispatched it.

Elvel has `Logger.shareContext()`, which covers the first half in this process
and stops at the queue boundary. Nothing in the repository mentions dehydrating
or rehydrating context; the matches for "hydrate" are model hydration.

Correlating "this job failed" back to "this request caused it" therefore means
threading an id through every job's constructor by hand, and remembering to.
`Context` also carries hidden values — visible to the application, never written
to a log line — which is how a tenant id or a user id travels without being
printed.

**Done when** a context repository exists, its values reach every log line, it
survives the queue boundary in both directions, and hidden values are supported.

### Rotation is daily, and there is no syslog

`daily` rotates once a day and prunes to `maxFiles`. Upstream also has
`rotating` with a configurable period, `monthly`, and `syslog`.

A busy application writing a gigabyte a day gets one file per day whatever its
size; a quiet one gets 365 tiny files a year.

**Done when** rotation can be by period or by size, and `syslog` is a driver.

---

## Macroable

### Nothing is macroable

`Macroable` exists in `packages/support/src/traits.ts`, with `macro()` and
`hasMacro()`, and the comment explains carefully why `this` must be the concrete
subclass.

**No class in the framework extends it.** A search across every package finds
zero `extends Macroable`. `Str` and `Arr` are plain object literals, `Collection`
is a class that does not extend it, and neither do the query builder, the
response helpers, the router, the validator, the cache repository or the HTTP
client.

In upstream the trait is on about forty classes, and it is *the* mechanism by
which a package extends the framework without patching it: `Str::macro`,
`Collection::macro`, `Response::macro('success', ...)`,
`Builder::macro('whereTenant', ...)`, `Rule::macro`. Here a package that wants
any of that has nowhere to put it.

Also missing from the trait itself: `mixin()`, which registers a whole class of
macros at once and is how most packages actually register them, and
`flushMacros()`, without which a test that adds a macro leaks it into the next.

And because `macro()` writes to `this.prototype`, it cannot extend the object
literals at all — `Str.macro(...)` is not even callable, since `Str` is not a
class.

**Done when** `Str`, `Arr`, `Collection`, the query builder and the response
helpers are all extensible by the same mechanism, `mixin` and `flushMacros`
exist, and the mechanism works for the static-style helpers as well as the
classes.

---

## Mail

Six transports — SMTP, SES, Resend, Postmark and Mailgun over plain `fetch` with
no library, plus `log`, `array` and a **`fallback`** transport upstream has no
equivalent of. Markdown mail with a theme, inline images by `cid:`, attachments
from a disk, per-recipient locale resolved before queueing, one queued job per
channel, `alwaysTo` for staging, and a mail preview browser upstream needs a
package for. The assertions go past upstream's: `assertOnlyRecipients`,
`assertSentCount`, `assertHasHeader`.

### No `Return-Path`, and no message priority

`alwaysTo`, `alwaysReplyTo` and the `from` default are all there.
`alwaysReturnPath` and a per-message `Return-Path` are not, and neither is
`priority`.

`Return-Path` is where bounces go. Without it every bounce lands on the `From`
address, so an application that wants to process them — remove a dead address,
stop sending to it — has nowhere to point the handler, and VERP (encoding the
recipient into the return path so a bounce identifies itself) is impossible.

**Done when** a return path can be set globally and per message, and each
transport maps it to its own field: SMTP's `MAIL FROM`, SES's `ReturnPath`, and
the provider equivalents.

---

## Pagination

`ModelBuilder.paginate()` and `cursorPaginate()` exist, and the cursor half is
done properly: multi-column keys compile to
`created_at > ? OR (created_at = ? AND id > ?)` so a page boundary is exact when
two rows share a timestamp, the cursor is base64url so it travels in a URL, and
there is deliberately no `total` because counting is the cost cursor pagination
exists to avoid.

### A page does not know its own URLs

```ts
export type Paginated<M> = {
  data: Collection<M>
  total: number
  perPage: number
  currentPage: number
  lastPage: number
}
```

Five numbers. Upstream's paginator answers `nextPageUrl()`, `previousPageUrl()`,
`url($page)`, `hasMorePages()`, `onFirstPage()`, `onLastPage()`, `firstItem()`,
`lastItem()`, `appends()`, `withQueryString()`, `path()`, `fragment()`, and
`through()` to map the items without losing the page.

The two that cost most are `withQueryString` and the page window. Without the
first, paging away from a filtered list drops the filters — the commonest
pagination bug there is. Without the second there is no `linkCollection` /
`getUrlRange`, so every application reimplements `1 … 4 5 6 … 20`, which is
`UrlWindow` and is more fiddly than it looks.

**Done when** a page can build its own URLs, keeps the current query string,
and exposes the window of page numbers to render.

### There is no `simplePaginate`

Every numbered page pays a `count(*)` over the whole filtered set to compute
`total` and `lastPage`. `simplePaginate` fetches `perPage + 1` rows instead and
answers only "is there a next page", which is all a Previous/Next control needs.

On a large filtered table the count is usually the slower of the two queries.

**Done when** `simplePaginate` exists on both builders and runs one query.

### The query builder cannot paginate

`paginate` and `cursorPaginate` are on `ModelBuilder` only. `QueryBuilder` has
`forPageAfterId`, `forPage` and `cursor`, and no page.

So a report, an aggregate, or any join that is not a model — the queries most
likely to be large enough to need paging — has to be paged by hand.

**Done when** both live on the query builder and the model builder inherits
them.

### A paginated resource does not serialise as one

`ResourceCollection.withMeta()` takes whatever you hand it. Upstream's
`PaginatedResourceResponse` emits `data`, `links` (`first`, `last`, `prev`,
`next`) and `meta` (`current_page`, `from`, `last_page`, `path`, `per_page`,
`to`, `total`) without being asked, which is the shape every JavaScript client
library already understands.

Here the totals are assembled by hand at each call site, and the `links` object
cannot be built at all because the paginator has no URLs.

**Done when** handing a page to a resource collection produces that shape.

---

## Pipeline

`send`, `through`, `pipe`, `via`, `then`, `thenReturn`, a resolver in place of
`setContainer`, and `Pipehub` for upstream's `Hub`. `finally()` runs on the way
out of a throw as well as a return, which is the only reason to have it. The
comment on `then()` names the thenable hazard — a class with a `then` member
must never be awaited — and the queue's job middleware runs on this same code.

### `withinTransaction()` is absent

Upstream's pipeline can wrap the whole run in a database transaction, so a chain
of stages that each write commit together or not at all.

It is not a one-liner here, and that is the row: `@elvel/support` must not
depend on `@elvel/database`. The pipeline already takes a resolver for named
stages, so a transaction runner can be injected the same way — the decision is
what that contract looks like, not whether it can be done.

**Done when** a pipeline can be told to run inside a transaction without support
importing database.

---

## Process

`run`, `start`, `pool`, `concurrently`, `pipe`, `timeout`, `idleTimeout`,
`forever`, `quietly`, `env`, `path`, `input`, `signal`, `stop`, `wait`,
`waitUntil`, the fake with a sequence and stray-process prevention, and
`ProcessFailedError` puts the command's own error output in the message rather
than only "exited with code 1". `json()`, `lines()`, `onOutput()` and
`onFinished()` have no upstream counterpart.

### No TTY

`tty()` and `supportsTty()` are missing. A command cannot hand its terminal to
the process it starts, so anything interactive — an installer that asks a
question, `ssh`, an editor, a REPL — cannot be run from an Elvel command at all.
It is not slow or awkward; it does not work.

**Done when** a process can inherit the terminal, and asking for it where there
is no TTY is an error rather than a hang.

---

## Queue

Four connections (sync, database, redis, sqs), the worker with `--once`,
`--stop-when-empty`, `--tries`, `--backoff`, `--timeout`, `--sleep`,
`--max-jobs`, `--max-time`, a full command set including `queue:pause`,
`queue:resume`, `queue:monitor`, `queue:retry-batch` and `queue:prune-batches`,
model serialisation by identifier, unique jobs, encrypted payloads, job
middleware sharing the pipeline, and `queue:flush --hours` covering
`queue:prune-failed`. Batching is recorded under Bus.

### There is no circuit breaker

Job middleware is `WithoutOverlapping`, `RateLimited` and `Skip`. Upstream also
has `ThrottlesExceptions`, `FailOnException`, `Release` and
`SkipIfBatchCancelled`.

`ThrottlesExceptions` is the one that matters. A job calling a third-party API
that has gone down fails, retries, fails, retries — for every job in the queue,
against a service that is already struggling, until the attempts run out and
the whole backlog is in `failed_jobs`. The middleware opens a circuit after N
failures and releases the rest of the jobs untouched until it closes.

This is the first thing anybody adds after their first outage, and there is
nothing to add.

**Done when** a job can declare an exception threshold and a decay, jobs are
released rather than attempted while the circuit is open, and the circuit is
shared across workers through the cache.

### There is no way to turn the queue off, and no failover

Connections are `sync`, `database`, `redis` and `sqs`. Upstream also ships
`null` — discard everything, for an environment that must not run background
work — and, since 13, `FailoverQueue`, which tries the next connection when one
is unreachable.

Without failover, a Redis that stops answering turns every `dispatch()` in every
request into an exception. That is the same failure shape recorded under Cache,
and it is worse here: the dispatch usually happens after the work that mattered
has already been done.

The failed-job stores have the same shape — `array` and `database` only, where
Upstream also has `file`, `dynamodb` and `null`, so a service with a queue and no
database has nowhere to record a failure.

**Done when** `null` and a failover connection exist, and a failed job can be
recorded without a database.

---

## Redis

There is no Redis package. Three packages each build their own client:

```ts
// packages/cache/src/stores/redis.ts
// packages/queue/src/drivers/redis.ts
// packages/broadcasting/src/redis.ts
import { RedisClient } from 'bun'
```

each from its own config key — `cache.stores.redis.url`,
`queue.connections.redis.url`, `broadcasting.redis.url`.

### Nothing shares a Redis connection

An application using cache, queue and broadcasting opens **at least four**
connections per process — broadcasting needs two, because a client in subscribe
mode may issue nothing else — and every worker and every web process multiplies
that. Upstream resolves one connection per *named* connection and hands the same
one to every consumer.

Pointing them all at one server also means saying so three times, in three
config files, with three environment variables that can drift apart.

And application code has nothing: a sorted set for a leaderboard, a Lua script,
a `SCAN` over keys — there is no `Redis::connection()` to reach for, so the
application constructs a fourth client of its own.

Clusters are not reachable either; each site passes a single URL.

**Done when** there is one Redis manager with named connections, the three
packages resolve from it, an application can reach a connection by name, and a
cluster can be configured once.

### Redis commands are invisible

Upstream dispatches `CommandExecuted` and `CommandFailed` for every command, and
that is what a Redis watcher is built on. Nothing here dispatches anything —
Lens has watchers for queries, cache operations, jobs, mail and thirteen more,
and none for Redis.

So on a page whose slowest part is a Redis call, the bar shows the request
taking 400ms and cannot say where any of it went. Cache entries cover the
operations that go through `@elvel/cache`; a broadcast publish, a queue pop, or
anything the application runs directly is not recorded at all.

**Done when** commands are dispatched as events with their timing, and Lens has
a Redis watcher.

---

## Routing

More complete than expected. Verbs, `any`, `match`, groups with prefix, name,
domain and middleware; `fallback`; `redirect` and `permanentRedirect`; view
routes; `resource`, `apiResource` and singleton resources; constraints
(`where`, `whereNumber`, `whereAlpha`, `whereIn`, `whereUuid`, `whereUlid`,
`whereEach`); implicit model binding with custom keys (`{post:slug}`), scoped
bindings, `withTrashed` and `missing`; global patterns; middleware aliases,
groups **and priority**, with the priority sort deliberately stable so two
middleware of your own keep the order you wrote them in.

### URL generation stops at `route()`

`route(name, parameters, absolute)` is the whole of it — and it defaults to
relative, which is the better default and is argued for in the source.

Missing: `url(path)` for a URL to an arbitrary path, `asset(path)` for a file in
`public/`, `secureUrl`, `URL::forceScheme`, and `URL::defaults`.

`asset()` is the one that bites. Every image, font and stylesheet not going
through Vite has its path written by hand in a template, so moving static files
to a CDN means editing every template instead of setting `ASSET_URL`.

`URL::defaults` is the other: an application with a locale segment
(`/{locale}/articles`) must pass the locale to every single `route()` call, or
set it once as a URL default. Without defaults, a missing parameter is an error
at the call site farthest from where the locale is known.

**Done when** `url`, `asset` and `secureUrl` exist, honour a configured asset
host and scheme, and URL defaults are applied to generated route URLs.

### There are no atomic route locks

`Route::block($lockSeconds, $waitSeconds)` holds a lock keyed on the route and
the authenticated user, so a second concurrent request to the same route waits
rather than running beside the first.

It is the one-line answer to a double-submitted form, a double-clicked "Pay"
button, and a mobile client retrying a request whose response it never received.
The cache package already has the locks it would be built on — `Lock` with an
owner token, `block()` measured against the clock — and nothing in the router
reaches for them.

**Done when** a route can declare a lock, the wait and the hold are separate,
and a timed-out wait is a `429` rather than a hang.

---

## Testing

62 response assertions against upstream's 75, and the overlap is not the whole
story: Elvel adds a named assertion for nearly every status code
(`assertConflict`, `assertGone`, `assertPayloadTooLarge`, `assertNotModified`),
an `AssertableJson` with the fluent `has`/`each`/`etc`, and console testing with
`expectsConfirmation` and `assertOutputInOrder`. `test(app)` presses the
application through the same `handle()` a server would, so the session, the
middleware and the exception handler all take part, and nothing depends on a
test runner.

### The commonest web flow cannot be asserted

Upstream has nine session assertions — `assertSessionHas`, `assertSessionHasAll`,
`assertSessionHasErrors`, `assertSessionHasErrorsIn`, `assertSessionHasInput`,
`assertSessionHasNoErrors`, `assertSessionDoesntHaveErrors`,
`assertSessionMissing`, `assertSessionMissingInput` — and four view assertions:
`assertViewHas`, `assertViewHasAll`, `assertViewIs`, `assertViewMissing`.

Elvel has none of either. So "post an invalid form, get redirected back, with
the errors and the old input in the session" — the single most common flow in a
server-rendered application, and the one `errors.ts` and `old()` exist to
serve — can only be asserted by following the redirect and searching the HTML
for the message.

Missing with them: `assertRedirectBack`, `assertRedirectBackWithErrors`,
`assertRedirectToRoute`, `assertRedirectToSignedRoute`,
`assertJsonValidationErrors`, `assertOnlyInvalid`, `assertDownload`,
`assertStreamed` and `assertStreamedContent`.

**Done when** the session and its error bags can be asserted directly, and a
redirect can be checked against a route name.

### The clock exists, and almost nothing reads it

`Clock` in `@elvel/support` freezes, advances and travels, and a faked `Sleep`
moves it — which is what turned a blocking-lock test from 750ms of spinning into
3ms. `Lock.block()` is the only caller so far.

Everything else still reads `Date.now()` directly: the rate limiter, the session
sweep, `flexible()`, the baseline, token expiry, the daily log driver's
"injectable clock, so retention is testable without waiting a day", and every
scheduled frequency. Each of those is a test that has to wait or hand-roll a
clock of its own.

There is also no `travel`/`travelTo`/`freezeTime` on the test helper, so a test
reaches for `@elvel/support` rather than for the thing it is testing with.

**Done when** framework code reads `Clock.now()`, the six hand-rolled clocks are
deleted, and `@elvel/testing` exposes `travel` and `freezeTime` that restore
themselves after each test.

### A failing test hides its own exception

`withoutExceptionHandling()` and `withoutMiddleware()` do not exist.

So a test that gets a 500 sees the rendered error page. The stack trace, the
message and the line are all inside the handler that turned the exception into
a response, and the way to see them is to edit the application. Upstream's
answer is one call that puts the exception back on the surface.

`withoutMiddleware` is the same idea for the other common case: proving that a
handler is correct when a middleware is what is actually refusing the request.

**Done when** both exist, and `withoutExceptionHandling` rethrows with the
original stack.

---

## Translation

Group files (`lang/en/orders.ts` → `orders.*`), JSON-style whole-sentence
translations kept apart from the groups and consulted first, `choice()` with
plural selection, a fallback locale, and `whenMissing`. A missing key returns
**the key itself** rather than an empty string, which is what makes translating
incremental.

### The locale is process-global, and swapping it races

```ts
export class Translator {
  constructor(private locale = 'en', private fallback = 'en') {}
  setLocale(locale: string) { this.locale = locale }
```

One mutable field on a singleton. There is no request-scoped locale, nothing
reads `Accept-Language`, and there is no `preferredLocale()` on a user.

The consequence is already in the framework. `NotificationSender.inLocale()`
does this:

```ts
const previous = translator.getLocale()
translator.setLocale(locale)
try { await body() } finally { translator.setLocale(previous) }
```

with the comment: *"a channel that throws must not leave the process speaking
the last recipient's language to everybody after them."* The `finally` handles
the throw. It does not handle the `await` — while `body()` is suspended, every
other request in the process renders in that recipient's language, and the
sender is looping over recipients so it happens on every send.

`packages/core` already has `requestSlot()`, and `AuthManager` and the cookie
bag both use it for exactly this reason.

**Done when** the locale lives in the request scope, `Accept-Language` and a
user's `preferredLocale()` can set it, and `inLocale()` enters a scope rather
than mutating a field.

### A package cannot ship translations

`addNamespace()` and the `package::group.key` syntax do not exist, and no
package in the repository ships a `lang/` directory.

The framework's own messages show what that costs. `packages/validation/src/messages.ts`
is a `Record<string, string>` of English sentences —

```ts
export const MESSAGES: Record<string, string | SizeMessages> = {
  accepted: 'The :attribute field must be accepted.',
  after: 'The :attribute field must be a date after :date.',
```

— and the validation package never imports the translator: a search for
`translator`, `__(` or `trans(` across `packages/validation/src` finds nothing.

So **validation messages cannot be translated**. An Indonesian application
cannot publish `lang/id/validation.ts`; it has to pass an override for every
rule at every call site. The same is true of any message a package emits.

**Done when** a package can register a namespace, the validator resolves its
messages through the translator, and `lang/<locale>/validation.ts` overrides
them.

### Messages come from the filesystem, and only from there

`Translator.load(directory)` calls `readdir` and `readFile`. Upstream puts a
`Loader` interface in front — `FileLoader`, `ArrayLoader` — so messages can come
from a database, an API, or an array.

`add()` and `addSentences()` cover the in-memory case, so tests are fine. What is
not possible is the one that motivates the interface: translations edited by
non-developers in a database or a CMS, loaded at boot and refreshed without a
deploy.

This is the one extension point in the framework with no published contract —
every other one is recorded under Contracts as present.

**Done when** loading is a contract, the file loader implements it, and it is
exported.

---

## Validation

**All 108 of upstream's rules are implemented.** So are `Rule::unique` and
`Rule::exists` with a presence verifier, `Rule::anyOf`, `Rule::enum`,
`Rule::dimensions`, `Rule::file`, `Rule::password` with `uncompromised()`,
conditional and nested rules, wildcards, `sometimes`, `bail`, `after` hooks,
`stopOnFirstFailure`, `safe()`, custom rules through `extendRules`, and a
JSON-Schema builder with a TypeBox bridge that has no upstream counterpart.

`validated()` is stricter than upstream's: it walks the declared rule keys rather
than the payload, so an unvalidated nested key cannot reach a database write —
which is what upstream needs `excludeUnvalidatedArrayKeys` to opt into.

Two things are missing, and one of them is only visible from Translation:
**validation messages cannot be translated**, because the catalogue is a
hardcoded English `Record` and the package never imports the translator. That is
recorded under Translation.

### `Rule::can()` is absent

`'post_id' => [Rule::can('update', Post::class)]` runs the gate as a validation
rule, so authorisation failures arrive in the error bag beside the field they
concern instead of as a 403 that says nothing about which field was wrong.

The gate is there and the rule contract takes a closure, so this is a small
piece — but writing it per project means writing the message and the field
mapping per project too.

**Done when** the rule exists, resolves the gate lazily so validation still
works with no auth package, and reports through the normal message resolution.

### `email` is one permissive regex

```ts
email: ({ value }) =>
  typeof value === 'string' && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value),
```

Upstream's rule takes modes — `rfc`, `strict`, `dns`, `spoof`, `filter` — and
they are chosen per field because the right strictness differs: a sign-up form
wants `dns` so a typo'd domain is caught at the form rather than at the first
bounce, and an admin import wants `rfc` and nothing else.

`spoof` is the one with teeth. It rejects a homograph address — a Cyrillic `а`
standing in for a Latin `a`, so `аdmin@company.com` is a different address that
reads identically — which is how a lookalike account gets created and then
mistaken for the real one. Nothing here looks at that, and the DNS check that
does exist belongs to `active_url`, not to `email`.

**Done when** `Rule::email()` takes modes, `dns` and `spoof` are among them, and
the default stays the cheap regex.

---

## View

There is no template compiler, and most of Blade is a compiler feature that JSX
gets for free: loops, conditionals, escaping, components, slots as children,
props as props. What the framework adds around it is present — stacks
(`stack`, `push`, `prepend`, `once`, `pushOnce`), `whenError`/`errors`/`old`,
`whenAuth`/`whenGuest`/`whenCan`, `csrfField()`, `methodField()`, `@elvel/vite`,
`classes()`/`styles()`/`json()`, `render()` for a string, and a `stream()` that
sends a page in parts so a slow query does not hold the shell.

### An application cannot add ambient view data

`View::share()`, `View::composer()` and `View::creator()` have no counterpart.
`ViewFactory` is `render` and `build`, and a search for `share` or `composer`
across `packages/view` finds nothing.

The framework itself relies on ambient view data constantly: `errors()`,
`old()`, `stack()`, `csrfField()` and `cspNonce()` are all read from the request
scope inside a component, not passed as props. An application has no way to
register one of its own, so anything a layout needs on every page — the unread
count, the current tenant, the feature flags, the navigation — is threaded
through the props of every handler that renders that layout, and adding one
means editing all of them.

The answer is not upstream's untyped `share()`: `view(Component, props)` being
type-checked is the point of this package. The answer is the pattern already in
use — a registered, typed request-scoped value with a reader a component calls.

**Done when** an application can register request-scoped view data with a typed
reader, computed lazily so a page that does not read it does not pay for it.

---

## Not a gap, recorded so it is not re-argued

- **Programmatic sign-in** (`Auth::login`, `loginUsingId`, `attempt`, `logout`)
  is reachable: `api()` in `packages/auth/src/responses.ts` exposes better-auth's
  full server API, typed by the application through `AuthTypes`.
- **`Auth::viaRequest`** is `AuthManager.extend(name, resolver)` plus
  `guard(name)`.
- **Password reset and email verification** are better-auth's, with Elvel's
  `ResetPasswordNotification` and `VerifyEmailNotification` on top.
- **`Illuminate\Auth\Access\Response`** is matched method for method by
  `AuthorizationResponse`.
- The `can:` middleware cannot authorise against a route-bound model, and its
  comment says route bindings "do not exist here yet". **The comment is out of
  date** — `packages/http/src/bindings.ts` implements them, scoped child
  bindings and `withTrashed` included, and `bindings` is a registered middleware
  alias. What is missing is only the wiring: `canAccess` passes its arguments
  through as strings instead of reading the resolved binding. Recorded under
  Auth as part of the gate work rather than as a routing gap.
- **Higher-order proxies** (`$users->map->name`, `$posts->each->delete()`) are
  left out on purpose. A `Proxy` could do it, and the result would be a member
  access TypeScript cannot type, which trades the framework's one real advantage
  over upstream for brevity.
- **Concurrency has no gap.** upstream has `run` and `defer` over `process`,
  `fork` and `sync`; Elvel has `run`, `defer`, and `settle` over `worker` and
  `sync`. The two upstream drivers that are missing exist because PHP cannot
  await, which is not a constraint here — the reasoning is written into
  `ConcurrencyManager`. What Elvel adds on top: `settle()` for the
  all-or-report case, a timeout that actually terminates the thread rather than
  only bounding the wait, and failures reported in declaration order so which
  error you see does not depend on the machine.
- **Autowiring and method injection are out of reach**, not postponed.
  `Container::build()` news up any class by reading its constructor's
  type-hints, and `Container::call()` does the same for a method's parameters;
  every `#[Config]`, `#[CurrentUser]`, `#[Storage]` attribute is built on that
  machinery. TypeScript erases types at compile time, so nothing at runtime
  knows what a constructor wants. Decorators plus `emitDecoratorMetadata` could
  recover part of it, at the price of a decorator on every injectable class and
  a second, weaker type system beside the real one. An explicit factory —
  `singleton('mailer', (app) => new Mailer(app.make('config')))` — says the same
  thing, checked by the compiler.
- **Contracts is not a component gap.** upstream publishes 155 interfaces in one
  package so an application can type-hint without depending on an
  implementation. Elvel publishes each contract from the package that owns it —
  `Store` from `@elvel/cache`, `QueueDriver` from `@elvel/queue`, `Transport`
  from `@elvel/mail`, `Hasher`, `Encrypter`, `Rule`, `NotificationChannel`,
  `LogDriver`, `SessionDriver`, `Disk`, `PubSub`, `ConnectionResolver` — as
  type-only exports, which are erased at compile time and so create no runtime
  dependency. `@elvel/contracts` holds only what would otherwise be circular:
  the container bindings, `ApplicationContract`, `ServiceProviderContract`.
  Every extension point checked has a published type. The one that does not —
  a loader contract for translations — is recorded under Translation as a gap.
- **Encryption has no gap, and is ahead.** upstream still supports AES-CBC with a
  separate HMAC; Elvel is AES-256-GCM only, binds the context into the
  authentication tag as AAD rather than prefixing an HMAC to the plaintext,
  derives keys with a purpose label, and gives one `DecryptError` for every
  rejection reason so a padding oracle has nothing to read. `previousKeys` for
  rotation matches upstream; `blindIndex`, envelope encryption with a pluggable
  master key provider, and the `encryption:rotate` command have no upstream
  counterpart. Only `supported()` and `getAllKeys()` are missing, and both are
  introspection for a cipher choice Elvel does not offer.
- **Package auto-discovery is deliberately absent.** upstream reads
  `extra.laravel.providers` from every installed composer package and registers
  what it finds. Elvel lists providers in `bootstrap/providers.ts`. Discovery
  buys one less line on install and costs the two things this framework is for:
  the provider list is typed and checked, and a provider nobody imported is not
  in the bundle. `AliasLoader` and `Mix` are absent for the same reason —
  ESM imports and `@elvel/vite` already do the job.
- **Hashing has no gap.** `make`, `makeSync`, `check`, `needsRehash`, `info`,
  `isHashed`, `driver`, `extend`, over bcrypt and argon2id, with the parameters
  read back out of the hash string so `needsRehash` is real. It refuses a bcrypt
  input over 72 bytes rather than truncating it — Bun does not truncate where
  most implementations do, so a hash made here from a long passphrase would stop
  verifying the day it moved to a library that does. Only upstream's
  `verifyConfiguration()` has no counterpart, and `info()` plus `needsRehash()`
  answer the same question.
- **`response()->streamDownload()` is not counted.** A generated CSV is
  `new Response(stream, { headers })`, six lines, and `contentDisposition()` is
  already exported from `@elvel/storage`.
- **JsonSchema has no gap.** upstream added a schema builder with eight types
  and a deserializer. `packages/validation/src/schema` has all eight —
  `string`, `integer`, `number`, `boolean`, `array`, `object`, `anyOf`,
  `union` — plus `fromJsonSchema()` for the round trip, and a TypeBox bridge
  (`toTypeBox`/`fromTypeBox`) with no upstream counterpart, which is what lets
  one schema be both a published document and a validator Elysia compiles.
- **Notifications has no gap.** All four events (`sending`, `sent`, `failed`,
  `skipped`), `markAsRead`/`markAsUnread`/`unread`, anonymous routing,
  `shouldSend`, `viaQueues`, per-recipient locale, delay, and the three channels
  upstream still ships in the framework — mail, database, broadcast — plus a
  `log` channel it does not. Slack and Vonage are **not** missing: Upstream moved
  both out of `illuminate/notifications` into separate first-party packages, and
  its `Channels/` directory holds the same three. The queued path is better
  factored than upstream's: one job per channel, so a mail server being down does
  not stop the database row being written, and the locale is resolved while the
  recipient model still exists rather than in the worker where it does not.
- **Reflection is out of reach, like autowiring.** upstream's `Reflector`
  answers `getParameterClassName`, `isParameterSubclassOf`,
  `isParameterBackedEnumWithStringBackingType` and reads class attributes —
  every one of them a question about types that exist at runtime in PHP and are
  erased at compile time in TypeScript. `ReflectsClosures`, which infers an
  event type from a listener's parameter, is the same. Same reasoning as the
  container's `build()` and `call()`.
- **Scheduling has no gap.** Every frequency upstream has, down to
  `everyTwoSeconds` and `twiceMonthly`; `onOneServer`, `withoutOverlapping`,
  `runInBackground`, `environments`, `evenInMaintenanceMode`, `when`/`skip`,
  `repeat`, `timezone`, `group`; output to a file or an email, and pings before,
  on success and on failure — which is the only thing that can notice a schedule
  that stopped running altogether, since no hook inside a process that is not
  running can. `schedule:run`, `schedule:work`, `schedule:list`,
  `schedule:test`, `schedule:interrupt`, `schedule:pause`, `schedule:resume` and
  `schedule:clear-cache` are all there, and all five task events are dispatched.
  upstream's `onSuccessWithOutput` has no separate method because the hook is
  handed the event and `event.output` is filled by the runner before it runs.
  `then()` is deliberately absent: a chainable builder with a `then` member is a
  thenable, and `await schedule.call(...)` would hand `resolve` to it as a hook.
- **A cookie session driver is not counted.** upstream's exists mainly to avoid
  shared server-side storage across instances; the `cache` driver over Redis
  answers that properly, without a 4 KB ceiling on everything the session holds.
  Sessions can already be turned off with `session.enabled`, so `null` has
  nothing to add either.
- **Blade fragments are not a gap.** `@fragment` exists because a Blade view is
  a file, so returning one region of it needs a marker. A JSX component *is* the
  region: `render(TheRow, props)` returns exactly that markup, which is what an
  HTMX or Turbo partial update wants.
- **Attribute bags are not a gap.** `$attributes->merge(['class' => ...])`
  forwards a component's attributes with class names appended rather than
  replaced. In JSX that is `<div {...rest} class={classes(base, rest.class)}>`,
  and `classes()` already does the merge.
- **`view:cache` is not a gap.** Blade compiles templates to PHP at runtime and
  caches the result; JSX is compiled by Bun before it runs.
- **A lost connection is not a gap, and this row was wrong.** It was written from
  the absence of upstream's `DetectsLostConnections` in the source, reasoning that
  a queue worker holding one connection would fail every job after MySQL's
  `wait_timeout` closed it. Measured instead: `Bun.SQL` is a pool, not a single
  connection. Kill the backend with `pg_terminate_backend` or MySQL's `KILL` and
  the next query opens a fresh one and answers — reads and writes both, and
  without carrying on inside a transaction that the kill destroyed. Upstream needs
  the trait because PDO holds one connection and cannot do this.
  `packages/database/test/reconnect.test.ts` pins all three behaviours against
  real servers, because the queue depends on them completely and nothing else in
  the suite would notice if a Bun release changed them.
- **`Number.spell()` cannot be written.** ECMA-402 has no rule-based number
  formatting, so ICU's spellout is unreachable from JavaScript, and a
  hand-written English speller in a framework that ships a translator would be
  the wrong file for it. Every other `Number` method is there.
- **Support is closed.** `Str` is 92 of upstream's 111 with a `Stringable`
  projected from it rather than written twice, `Number` over `Intl`, `Sleep`
  and `Clock` that a test can move, `Lottery`, `Timebox`, and the global
  helpers with a `retry` whose backoff is asserted as a sequence. What is still
  absent from `Str` is argued in its own source: `apa` encodes one style guide,
  `markdown` needs a parser the package will not depend on, and
  `createUuidsUsing` waits on a design for deterministic ids.
- **Config is closed.** The checked readers (`string`, `integer`, `float`,
  `boolean`, `array`) throw naming the key and what was there, `getMany` takes
  its shape from the defaults it is given, and `push`/`prepend` treat a missing
  key as an empty array so a package can append before anything has declared
  one. The twelve numeric reads in the framework use them.
- **Conditionable is closed.** `when()` and `unless()` resolve a function
  condition, pass the resolved value to the callback, and take an `otherwise`
  branch — in the trait and on the query builder, which had the same four lines
  twice.
- **Session is closed.** `push`, `increment`, `decrement`, `remember`, `only`,
  `except`, `hasAny`, `missing`, `replace`, and a `now()` that flashes for this
  request rather than the next.
