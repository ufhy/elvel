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

**Open: 86** — all 37 components measured.

Thirteen added none: Concurrency, Conditionable, Config, Contracts, Encryption,
Hashing, JsonSchema, Mail, Notifications, Reflection, Scheduling, Session and
Support. Four are ahead of upstream rather than level with it, and the reasons
are at the bottom.

Scheduling sits inside Console upstream; here it is a package of its own and is
measured separately.

---

## Auth

`auth.basic` and `auth.basic.once` put a username and password in front of a
route — the thing every internal tool, staging environment and `/metrics`
endpoint reaches for first, and there was no way to do it at all. The challenge
carries `WWW-Authenticate`, without which a browser shows the 401 body and never
prompts. The header is split on the **first** colon, because a password may
contain one and a username may not. The credential comparison is better-auth's,
which hashes before it compares; `once` signs straight back out rather than
leaving a session row per poll.

Fourteen events exist and `announce()` dispatches them when an events package is
registered. Sign-in, sign-out, registration and verification come from
better-auth's database hooks, so they fire on the paths that never see a request
— a console command creating a user, a worker verifying one. A failed sign-in
writes nothing, so `Failed` and `Lockout` are read from the endpoint hooks
instead.

`Login` and `Logout` carry the user's **id**, not the row: a sign-in writes a
session and a session carries `userId`, and loading the user to fill the event
would put a query on every sign-in for the sake of listeners that may not exist.

`createAuthMiddleware` is imported inside the options builder rather than at the
top of the provider — importing it eagerly evaluates better-auth on any import
of `@elvel/auth`, which is 65ms and forty modules for an application that never
reaches an auth route, and `lazy-imports.test.ts` refuses it.

`registeredAbilities()` and `registeredPolicies()` read the gate back, which is
what says a policy you wrote was never discovered.
`defaultDenialResponse()` takes a factory rather than a response, because a
response carries a status and is handed to every caller — one shared instance
would let the first caller's `withStatus` change everybody else's.
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

`Collection` and `Arr` carry the operators and the typed readers, `LazyCollection`
carries them over a stream — `take(5)` on a million-row table reads five,
`remember()` holds only what was walked, and `ModelBuilder.lazy()` returns one
instead of a bare generator — and `KeyedCollection` is the keyed half, so
`keyBy`, `mapWithKeys`, `groupBy`, `countBy`, `mapToGroups` and `mapToDictionary`
answer with something that can still be mapped rather than a plain object that
ends the chain. A `Map` underneath, not an object, so a numeric key stays a
number and insertion order is the order.

Some names stay out, with reasons. The strict `where` variants are what this
`where` already does — upstream needs the pair only because PHP's `==` does not
compare types. And `Arr.map`, `some`, `every`, `push`, `join`, `take`, `exists`,
`from`, `accessible` and `arrayable` are each a native array method or
`Object.hasOwn`, which upstream cannot lean on because a PHP array is not an
object.

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

Complete but for the two pillars TypeScript cannot have: autowiring (`build()`)
and method injection (`call()`) both need runtime type information, and types
are erased. Everything else is here — `bind`, `singleton`, `scoped`, `instance`,
the `…If` variants, `extend`, `rebinding`/`refresh`, `tag`/`tagged`,
`when().needs().give()`, the three resolution hooks, and `flush`/`forget…`/
`resolved`/`isShared`/`getBindings`, which `elvel about --bindings` prints.

Two adoptions the rows here used to ask for were measured and declined.
`AuthManager`'s slot is not a container binding: the session is set from outside
by middleware and nests through `run()`, which is not what a lazily built
per-request instance is. And the watcher, job and channel registries are typed
lists whose keys are known at compile time; rebuilding them on string tags would
lose that for nothing.

---

## Cookie

`CookieBag`, `CookieJar` and `cookiePlugin` cover upstream's `EncryptCookies` and
`AddQueuedCookiesToResponse` faithfully — an `except` list for cookies something
else must read, `Set-Cookie` appended rather than assigned so the session
plugin's header survives, a cookie that fails to decrypt read as absent so a key
rotation resets a preference instead of throwing, and the header parsed once per
request rather than once per plugin.

Path, domain, `Secure` and `SameSite` have configured defaults now, applied by
the jar and overridable at any call site. `secure` unset follows the
environment, the same rule the session cookie already used — so an application
on HTTPS no longer depends on every call site remembering the flag.

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

`assertDispatched` takes a callback as well as a count, which is the difference
between "an order shipped" and "*this* order shipped", and `assertListening`
answers whether a provider actually registered its listener — the thing that
breaks silently when providers are reordered. A pattern that covers the event
counts, because the listener does hear it.

---

## Filesystem

The `Disk` contract carries 32 of upstream's methods, the `memory` disk is
`Storage::fake()` with `assertExists`, `assertMissing`, `assertCount`,
`assertDirectoryEmpty` and an `assertContents` upstream has no equivalent of, and
`fileResponse()` gets `Content-Disposition` right for a non-ASCII filename under
RFC 6266 — stripping quotes rather than escaping them, because a filename that
closes the quoted string early injects a header parameter.

`writeStream` is on the contract: the local disk pipes into a file handle, S3
uses a multipart upload, and the memory disk collects so a test exercises the
same path. A failed local write removes what it wrote, because a half-written
file is one a reader cannot tell from a complete one. `UploadedFile.store()`
goes through it, so a 2 GB upload no longer costs 2 GB of the process.

`fileResponse` advertises `Accept-Ranges` always — a client that does not know it
may ask will not ask — answers `206` with the slice, and `416` for a range it
cannot satisfy. One range only: a multipart `206` is a `multipart/byteranges`
body and nothing that matters sends more than one, so a header asking for
several is served whole, which is allowed and is what every server does.

The `read-through` driver puts a local disk in front of a remote one, with a TTL
and a byte budget. A write goes to the origin and drops the cached copy, because
a stale file served from local disk is worse than the latency it saved. Both
halves are ordinary disks resolved by name, so `memory` in a test and `local` in
production is configuration rather than a second implementation.

`Files` is the file API outside a disk, and the generators use it. It lives in
`@elvel/support` rather than here: the console is its largest caller and this
package depends on the console, so putting it here would have built the cycle
the layering exists to avoid. `sharedGet` is a plain read named the same way,
with a comment saying so — there is no portable advisory lock, and a hopeful
read pretending to be one would be worse than the honest name.
---

## Foundation

Maintenance mode with a bypass cookie, deferred callbacks flushed after the
response, trusted proxies with per-header control, the security headers, CSRF,
CORS, and a `middleware:list` command upstream has no equivalent of.

Input is normalised before anything reads it, so validation, a form request and
a handler all see the same values — a rule that ran on the raw ones would
disagree with the row that gets written. `password`,
`password_confirmation` and `current_password` are excepted at every depth and
not only at the top: a password whose trailing space was trimmed is one nobody
can type again.

Precognition is honoured. `Precognition-Validate-Only` narrows the rules, and a
wildcard rule answers for the key it expands to — `items.*.price` for
`items.0.price`, because the concrete key is ours and not something the client
wrote down. The success is **thrown**, carrying its `204`: a precognitive POST
to "create an order" validates the order and creates nothing, and a return value
the caller could ignore would create it.

The builder has `withMiddleware` and `withExceptions`. `withMiddleware` offers
`append` and no `prepend`: Elysia composes hooks in mount order and the
framework's own must run first — the request scope is entered by the first of
them, and anything ahead of it would read a scope that does not exist yet.
`withExceptions` hands over the bound handler's rules, so customising how one
exception renders is two lines rather than a handler subclass and a provider to
bind it. The rule method is `renderUsing`, because `render()` is the method
Elysia calls and a rule that shadowed it would replace the renderer instead of
adding to it.

`withSchedule` and `withEvents` are not here: a schedule is declared in
`routes/console.ts`, which `withConsole` already loads, and listeners are
registered by a provider. Both would be a second way to do something that has
one.
---

## Http

Route model binding is here and complete — `BindingRegistry` with implicit model
resolution, scoped child bindings, `withTrashed`, and hand-written resolvers for
anything that is not a model. So are API resources (`JsonResource`,
`ResourceCollection`, a `MISSING` sentinel), form requests with
`prepareForValidation`/`passedValidation`/`withValidator`, signed URLs, the
error bag and old input, CSRF, CORS, method override, the security headers, the
session with four drivers, and named rate limiters.

`InputBag` is the reading half: dot access, `only`/`except`/`filled`/`missing`,
`whenFilled`, `mergeIfMissing`, `collect`, and the typed readers. `boolean()` is
the one every form needs — an unchecked checkbox is absent, a checked one is
`"on"`, and `"0"` is false — and a form request exposes the same bag, so the two
cannot come to different answers about a checkbox.

`UploadedFile` stores an upload under a generated name. `hashName()` is random
rather than a content hash: hashing means reading the whole file to name it, and
two users uploading the same image would share a path, so deleting one account's
avatar would remove the other's. `storeAs` refuses a name carrying a path rather
than flattening it, because flattening hides the attempt. Streaming it to the
disk waits on `writeStream`, which is recorded under Filesystem.

`conditionalPlugin` answers `304` to a matching `If-None-Match` or
`If-Modified-Since`, on safe methods and successful responses only — a `304` to
a POST means something else entirely. A weak tag matches a strong one of the
same value, because the weak marker only rules out byte ranges.

`accepts`, `prefers`, `acceptsHtml` and `getAcceptableContentTypes` honour the
quality values, and rank by specificity within a quality — which is what makes
`Accept: */*;q=0.8, text/csv` mean "CSV, or anything".
---

## Image

Two halves, and the split is right: `probe()` reads format and dimensions out of
the bytes in pure TypeScript for eight formats with no dependency and no driver,
because the extension and the `Content-Type` a client sent are claims and the
header is the file. Transforming looks for a backend — `sharp`, ImageMagick,
`sips` — rather than assuming one, and a driver that cannot perform a queued
step says so instead of skipping it. the upstream component is new in 13 and
Elvel matches most of it.

An image reads from an upload, a disk or a URL and writes back to a disk under a
generated name. `hashName()` follows the *encoding* rather than the source: one
converted to webp and stored as `.png` is one every CDN and every browser will
mislabel.

`optimize()` re-encodes at the quality where the difference stops being visible
and changes nothing else — a phone camera writes JPEG at 95 and it looks
identical at 82. A format with no quality dial is left alone rather than
round-tripped, because a re-encode that changes nothing still costs a decode and
on a lossy format costs quality too.

`dominantColor()` resizes to a single pixel and reads it out of the 1×1 PNG. An
average rather than a histogram's mode, which is what a placeholder wants: the
mode of a photograph of a sunset is whichever band happens to be widest.
---

## Log

Nine drivers — `console`, `json`, `single`, `daily` with retention, `stack`,
`errorlog`, `slack`, `memory`, `null` — all eight PSR levels, `channel`,
`stack`, `build`, `extend`, `shareContext`, `withContext`, `withoutContext`,
`forgetChannel`, a `MessageLogged` event, deprecation logging, and a `log:tail`
command upstream has no equivalent of.

`Context` exists and it crosses the queue boundary: `dehydrate()` at dispatch,
`hydrate()` in the worker, so a job's log lines carry the request id of the
request that dispatched it without an id threaded through the constructor.
Hidden values are readable by the application and never written to a line, which
is how a tenant id travels without being printed. It lives in `@elvel/core`
rather than here, because the queue must reach it too and does not depend on
this package.

`rotating` rotates by period — hourly, daily, weekly, monthly, never — or by
size, or both, so a busy application does not put a gigabyte in one file and a
quiet one does not leave 365 tiny ones. `syslog` sends RFC 5424 over UDP; the
local `/dev/log` is a Unix datagram socket the runtime cannot open, and a
collector elsewhere is why syslog is reached for anyway.
---

## Macroable

`macroable()` extends an object of helpers in place and `Macroable` is the base
a class extends, both over one registry keyed on the target rather than its
name. `Str`, `Arr`, `Collection`, both query builders and `Redirect` are
extensible; `mixin()` registers a whole class at once and `flushMacros()` puts
back anything a macro shadowed, so a macro named after a real method does not
take that method with it.

Two notes. There is no response factory to make macroable — an Elysia handler
returns a value — so `Redirect` is the response-shaped thing that got it. And a
macro on `Str` is not chainable through `Str.of()`: the fluent chain is
projected from the helper object one import earlier, and joining them would make
`Stringable` a type defined in terms of its own projection.

---

## Pagination

Both builders answer with a `Paginator` that knows its own URLs — `url(page)`,
`nextPageUrl`, `firstItem`, `hasMorePages`, `through()` to map the items without
losing the page — and carries the request's query string into every one of them,
so paging away from a filtered list keeps the filters. `linkCollection()` is the
`1 … 4 5 6 … 20` window, and `toJSON()` is the `data`/`links`/`meta` shape a
resource collection now emits without being asked.

`simplePaginate` runs one query instead of two: `perPage + 1` rows and no
`count(*)`, which on a large filtered table is usually the slower of the pair.

The paginator lives in `@elvel/support` because a page is built in the database
layer and rendered in the http one, and neither imports the other. The http
provider hands it three resolvers at boot — the path, the query string and the
current page — the same shape the validator uses to find the gate.

`cursorPaginate` was already done properly: multi-column keys compile to
`created_at > ? OR (created_at = ? AND id > ?)`, the cursor is base64url, and
there is deliberately no total.

---

## Pipeline

`send`, `through`, `pipe`, `via`, `then`, `thenReturn`, a resolver in place of
`setContainer`, and `Pipehub` for upstream's `Hub`. `finally()` runs on the way
out of a throw as well as a return, which is the only reason to have it. The
comment on `then()` names the thenable hazard — a class with a `then` member
must never be awaited — and the queue's job middleware runs on this same code.

`withinTransaction()` wraps the whole run, and `finally()` still runs outside it
because releasing a lock must happen whether it committed or rolled back.
`@elvel/support` still does not import `@elvel/database`: the database provider
hands over a transaction runner at boot, the same shape the validator uses to
find the gate, and asking for one with no database is an error rather than a
quiet run without it.

---

## Process

`run`, `start`, `pool`, `concurrently`, `pipe`, `timeout`, `idleTimeout`,
`forever`, `quietly`, `env`, `path`, `input`, `signal`, `stop`, `wait`,
`waitUntil`, the fake with a sequence and stray-process prevention, and
`ProcessFailedError` puts the command's own error output in the message rather
than only "exited with code 1". `json()`, `lines()`, `onOutput()` and
`onFinished()` have no upstream counterpart.

`tty()` hands the terminal over, stdin included, so an installer that asks a
question, `ssh`, an editor or a REPL can be run from a command. `supportsTty()`
says whether there is one, and asking for a TTY where there is none is refused
at the spawn — a child handed a stdin that is not a terminal waits for input
that never comes, and a CI job that hangs for its whole timeout says nothing
about why.

---

## Queue

Four connections (sync, database, redis, sqs), the worker with `--once`,
`--stop-when-empty`, `--tries`, `--backoff`, `--timeout`, `--sleep`,
`--max-jobs`, `--max-time`, a full command set including `queue:pause`,
`queue:resume`, `queue:monitor`, `queue:retry-batch` and `queue:prune-batches`,
model serialisation by identifier, unique jobs, encrypted payloads, job
middleware sharing the pipeline, and `queue:flush --hours` covering
`queue:prune-failed`. Batching is recorded under Bus.

`ThrottlesExceptions` is the circuit breaker: after N failures every further job
is **released** rather than attempted, so a service that has gone down stops
being hammered by the backlog and nothing is lost. The circuit lives in the
cache, so it is shared across workers — a per-process breaker would open N times
and let N jobs through per failure. The failure count carries the decay too, or
ten failures spread over a week would eventually trip it whatever the service is
doing. `FailOnException`, `Release` and `SkipIfBatchCancelled` are here as well.

`null` discards everything, for an environment that must not run background work
— `sync` is the wrong answer there because it runs the job. `failover` tries the
next connection on a **push** only: a worker polling a dead connection should say
so, not quietly drain a different queue and leave the first one's backlog
unattended. It reports the *last* error rather than the first, because the first
is "Redis is down" and the one worth showing is why the fallback did not work
either.

Failures can be recorded without a database: `file` writes a line per failure and
skips a torn one on read, because a half-written line from a killed process must
not make every earlier failure unreadable.

Writing this found a small lie: `config/queue.ts` said `failed.driver: 'null'`
discards failures, and `null` fell through to the in-memory store. `null` now
does what the config said, and the default is written `array`, which is what it
always actually was.
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
bindings, `withTrashed` and `missing`; global patterns; URL generation beyond
named routes — `url`, `asset`, `secureUrl` and URL defaults; middleware aliases,
groups **and priority**, with the priority sort deliberately stable so two
middleware of your own keep the order you wrote them in.

`block:10,5` is the atomic route lock — one request at a time, per route and per
caller. The hold and the wait are separate because one number for both makes a
slow handler either unprotected or a hang, and a timed-out wait is a `429`.

Taken in a middleware and released in an `onAfterResponse` hook rather than
around a callback: Elysia cannot wrap a handler, so releasing before it ran would
be a check and not a lock — the second request would get in while the first was
still writing. `onAfterResponse` and not `onAfterHandle`, because a handler that
threw still holds it, and a lock a failed request kept would block the retry that
failure invites.
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

The session can be asserted directly — nine assertions, plus `assertRedirectBack`,
`assertRedirectBackWithErrors`, `assertRedirectToRoute`, `assertDownload` and
`assertStreamed`. It is read back **through the driver** after the response: the
request scope is gone by the time an assertion runs, and the driver is where the
data actually ended up. The whole read is structural, so `@elvel/testing` still
depends on nothing.

Framework code reads `Clock` — the cache stores and their expiry, `flexible()`,
the rate limiter, signed URLs, the session, the throttle, and the scheduler's
due-ness — and the three hand-rolled `now?: () => Date` options are gone.
`@elvel/testing` exposes `freezeTime`, `travel`, `travelTo` and `restoreTime`,
which remember what they moved so a test that forgets does not poison the ones
after it.

The scheduler's runner keeps `Date.now()` on purpose, and says so: its loop and
its durations measure elapsed real time, and a frozen clock would make the
deadline unreachable and spin the worker for ever — the trap `Lock.block()` fell
into from the other side.

`withoutExceptionHandling` puts the exception back on the surface, restoring in a
`finally` because a test that threw is exactly the one that would leave it on.
`withoutMiddleware` is **not** here: Elysia composes hooks into a compiled
handler at mount time, so there is nothing to remove per request — the honest
equivalent is mounting the route under test on a bare `Elysia`, which needs no
framework support.

Writing these found a real one: bun's `toMatchObject` does not compare a `Date`
at all, so the logger's assertion about the time it wrote had never checked
anything. It compares the ISO string now.
---

## Translation

Group files (`lang/en/orders.ts` → `orders.*`), JSON-style whole-sentence
translations kept apart from the groups and consulted first, `choice()` with
plural selection, a fallback locale, and `whenMissing`. A missing key returns
**the key itself** rather than an empty string, which is what makes translating
incremental.

The locale is request-scoped now. It was one mutable field on a singleton, and
`NotificationSender.inLocale()` swapped it and restored it in a `finally` —
which survives a throw and does not survive an `await`: while a channel was
suspended, every other request in the process spoke that recipient's language,
on every send. `withLocale()` enters a scope instead, `usingLocale()` is what a
middleware calls, and `Accept-Language` picks from the loaded locales when
`app.negotiateLocale` is on.

`addNamespace()` and `package::group.key` let a package ship messages an
application overrides one string at a time, and the validator resolves its
messages through the translator when one is registered — so an Indonesian
application publishes `lang/id/validation.ts` rather than overriding every rule
at every call site. Validation still does not depend on translation: it asks the
container, and nothing changes when nothing answers.

Loading is a contract. `TranslationLoader` is `groups`/`sentences`/`locales`,
`FileLoader` is the same reading the translator always did, and
`loadFrom(loader)` is what a database- or CMS-backed catalogue implements.
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

`email` takes modes — `rfc`, `strict`, `dns`, `spoof`, `filter` — and the
default stays the cheap regex, because most fields want an obvious typo caught
and nothing more. `dns` catches a typo'd domain at the form rather than at the
first bounce. `spoof` refuses a homograph, where a Cyrillic `а` stands in for a
Latin one and `аdmin@company.com` reads identically to somebody else's address;
it is a single-script check, which is what every such address violates and
almost no real one does.

One thing is still missing, and it is only visible from Translation:
**validation messages cannot be translated**, because the catalogue is a
hardcoded English `Record` and the package never imports the translator. That is
recorded there.

---

## View

There is no template compiler, and most of Blade is a compiler feature that JSX
gets for free: loops, conditionals, escaping, components, slots as children,
props as props. What the framework adds around it is present — stacks
(`stack`, `push`, `prepend`, `once`, `pushOnce`), `whenError`/`errors`/`old`,
`whenAuth`/`whenGuest`/`whenCan`, `csrfField()`, `methodField()`, `@elvel/vite`,
`classes()`/`styles()`/`json()`, `render()` for a string, and a `stream()` that
sends a page in parts so a slow query does not hold the shell.

`shared()` registers a request-scoped value with a typed reader a component
calls, computed on first read and remembered for the rest of the request — so a
page that never reads it never pays for it. `sharedValue()` is the same for
something a middleware establishes rather than computes.

Not upstream's untyped `share()`: the value is declared once and imported where
it is read, so a component that reads it is checked. That is the point of this
package.

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
- **Mail is closed.** `Return-Path` is set globally or per mailable, and each
  transport maps it to what it has: SMTP's `MAIL FROM` envelope, SES's
  `FeedbackForwardingEmailAddress`, Mailgun's `h:Return-Path`. Resend and
  Postmark have no envelope-sender field, so it travels as a header there —
  which is what a receiving server rewrites anyway.
