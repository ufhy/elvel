# Known gaps

What is deliberately missing, per package, so it is not rediscovered by
accident. Everything here is a decision, not an oversight; where something was
attempted and could not be made to work, that is said plainly.

**A row is removed only when nothing is left to say.** Finishing something usually
replaces its row with a narrower one — implementing `morphToMany` left "a morph map
for the type", implementing batches left "chains inside a batch" — so the list gets
*longer* as the framework gets more complete. That is the list becoming more
precise, not the work growing. What must never appear here is a row whose answer is
"this is not actually missing": four of those were written and then removed, and
they belong in the prose under each package instead.

Reviewed against the Laravel 13 documentation and, where behaviour mattered, the
`laravel/framework` source.

Every row was last checked against the code on 2026-08-13: each one's API was
grepped for in `packages/*/src`, and four rows that named something already
implemented were corrected — `Model::withoutTimestamps`, `Log::withoutContext`,
`connection.transactions.level`, and a duplicate pair about console prompting.

---

## @elysian/database — complete for this milestone

The query builder, schema builder, migrator and model layer cover the documented
Laravel surface that applies to this runtime, and are tested against **SQLite,
Postgres 17 and MySQL 9**.

Deliberately absent, with reasons:

| Missing | Why |
| --- | --- |
| Queued jobs *from a model* (`$model->notify()`-shaped sugar) | The queue exists and queued listeners now run through it; what is missing is sugar on the model itself. A model's lifecycle events are dispatched, so a queued listener on `model.created` already covers it. |
| Read/write connection splitting, sticky connections | Needs a second connection per config entry and a read/write router; worth doing when someone has a replica. `ConnectionManager` already keys connections by name, so this is additive. |
| Database transactions across connections (2PC) | `Bun.SQL` exposes `beginDistributed`, so this is reachable — no design obstacle, just unbuilt. |
| A transaction shared across *connection objects* | Bun.SQL hands the open transaction to the callback, so nested `transaction()` on the **scoped** connection becomes a savepoint, and `afterCommit()` registered on either object lands in the same commit. What cannot work is opening a nested transaction on the *pool* while one is open — Bun refuses, and it is right to. |
| Vector/similarity clauses (pgvector) | Needs its own grammar and the pgvector extension. |
| JSON `->` in **updates** and `whereJsonLength` | Writing one key inside a document, and asking an array's length, each need a grammar verb per dialect that wheres do not exercise. |
| Column *modification* (`->change()`) | Not portable: SQLite requires a full table rebuild. |
| `morphToMany` **through** another relation | Reaching a morph pivot via a second relation is a join shape nothing here composes yet. |
| `ofMany()` with a **closure** aggregate, and multi-column tie-breaks | `latestOfMany`/`oldestOfMany` take one column and break ties on the key, which is the pair Laravel's own helpers produce. An arbitrary aggregate, or ordering by two columns before the key, needs the general `ofMany` form. |
| `touchIfTouching` guessing the **inverse** relation | Laravel infers the inverse relation's name from the class name; here the pairing must be written down. |
| Custom encrypted cast keys, searchable ciphertext | The `encrypted` and `encrypted:json` casts are implemented over `@elysian/encryption`. What is missing is a blind index — a deterministic hash column you can search by — which is the only way to query an encrypted column and needs a schema decision per table. |
| `migrate --isolated`, `--squash`, `schema:dump` | Needs an advisory lock and a schema dumper per dialect. |

Two things to know about walking a table:

- **`chunk()` pages by offset and `chunkById` pages by key**, and the difference
  shows the moment rows are deleted while walking — which is the commonest reason
  to chunk at all. Every delete shifts the offset window back by one, so an offset
  walk silently skips rows it never handed over. There is a test that deletes as it
  goes and asserts `chunk()` sees fewer than it should, because that behaviour is
  worth pinning rather than discovering.
- **A cursor page has no total.** Knowing one costs a `count(*)` over the whole
  set, which is the expense cursor pagination exists to avoid. What it buys is a
  page that cannot repeat or skip a row when something is inserted mid-read.

Two things to know about the single-row relations:

- **`latestOfMany` is a joined subquery, not `orderBy().limit(1)`.** The limit is
  right for one parent and silently wrong for an eager load, where it returns one
  row for the entire set — so the first parent gets its newest child and everyone
  else gets nothing. What is joined is `max(column)` grouped per parent.
- **The key is aggregated alongside the column.** Two children can share a
  `created_at`, and without the key in the join the aggregate matches both — a
  "one" relation quietly returning two. There is a test that creates the tie on
  purpose.

Three things to know about pivots:

- **Pivot columns travel aliased and are then moved.** They are selected as
  `pivot_<column>` and lifted onto the accessor after hydration, which is what
  stops a pivot's `created_at` from overwriting the model's own. The aliases are
  removed *before* `syncOriginal`, or every eagerly loaded model would report
  itself dirty.
- **A pivot model is built by assignment, not by `fill()`.** `fill` honours
  `fillable` and a pivot declares none, so constructing one with its attributes
  produced an empty pivot — silently. `hydrate()` bypasses fill for the same
  reason.
- **The morph direction decides whose type is stored.** `morphToMany` stores the
  parent's, `morphedByMany` the related model's. Backwards, the relation returns
  nothing at all rather than failing, so both directions are covered by tests on
  SQLite, Postgres and MySQL.

**Verified limits of the databases themselves**, not of this code:

- MySQL refuses to `truncate` a table a foreign key points at, however empty the
  child is. Use `delete()`. The grammar does not silently disable foreign key
  checks.
- MySQL implicitly commits DDL, so a failing migration cannot be rolled back
  there. Migrations are wrapped in a transaction on SQLite and Postgres only —
  it is not pretended for MySQL.
- MySQL's system schema `mysql` does **not** enforce InnoDB foreign keys. The
  dialect test suite provisions its own database because of it.
- Lazy loading a relation cannot be synchronous on Bun: reaching the database is
  async, so `user.posts` cannot return rows the way `$user->posts` does. Relations
  are methods (`await user.posts().get()`), and `with()` prevents the N+1.

---

## @elysian/core

| Missing | Why |
| --- | --- |
| `config:cache`, `route:cache` | Bun's module cache already covers most of the cost; a config cache matters at Laravel's file count, not ours yet. |
| Contextual binding, tagged bindings, automatic constructor injection | The container is deliberately typed via `ContainerBindings` rather than reflective. TypeScript erases parameter types, so PHP-style autowiring would need decorators and `emitDecoratorMetadata`. |
| Maintenance mode in the **cache** | `down`/`up` keep the payload in a file, which is Laravel's default and the only one that works when the thing being repaired is the database or Redis. A cache-backed driver matters for a cluster, where every node has to learn about it — that needs a driver contract and a config key. |
| `MaintenanceModeEnabled` as an event *class* | Dispatched by name (`maintenance.enabled`, `maintenance.disabled`), as everything else here dispatches. |
| `terminate` callbacks / graceful shutdown hooks | `booted()` exists; the mirror on shutdown does not. |

## @elysian/console

| Missing | Why |
| --- | --- |
| Prompting for missing arguments or options | Neither is asked for: the parser fails with `missing: "name"` instead. `@clack/prompts` is already a dependency, so this is small. |
| `stub:publish`, `--pretend` for generators | Stubs are already overridable per project by dropping a file in `stubs/`. |
| Command isolation / `--no-interaction` conventions | Not yet needed. |

## @elysian/view

| Missing | Why |
| --- | --- |
| **Compile-time XSS checking** | Attempted and **blocked**: `@kitajs/ts-html-plugin`'s CLI reads `typescript.sys`, which TypeScript 7 removed from the default export, so it crashes under both Bun and Node. `safe` remains a runtime guarantee and a review responsibility. |
| Suspense / streaming responses | `@kitajs/html` supports it; our `view()` returns a complete `Response`. |
| Vite integration, asset versioning | The static plugin serves `public/`; there is no manifest reader. |
| Blade-style directives | Deliberate: views are typed JSX, so `tsc` is the template checker. |

## @elysian/events

Wildcards, halting, subscribers, `push`/`flush`, a fake — and listeners that run in
a worker instead of the request.

| Missing | Why |
| --- | --- |
| Broadcasting | Needs a driver and a socket layer. |
| Interface-based listeners (`addInterfaceListeners`) | Class events are matched by name; an interface has no runtime identity in TypeScript. |
| A queued listener on a **wildcard** | A wildcard listener is handed the resolved event name as well as the payload, and only one payload can travel. `listen('order.*', SomeQueuedListener)` throws rather than delivering something different in the worker. |
| `ShouldBeUnique` / `ShouldBeEncrypted` as *marker interfaces* on a listener | Both exist as statics — `encrypted = true` works today; uniqueness is a job-level static the wrapper does not copy yet. TypeScript has no runtime interface to test for. |
| Auto-discovery by the handler's parameter type | Laravel reads the type of `handle($event)` to know what a listener listens to. TypeScript erases it, so the pairing is written once: `events.listen(OrderShipped, NotifyWarehouse)`. |

Four things to know about a queued listener:

- **It is a class, not a closure.** A worker is a different process, so only a name
  travels — the same constraint jobs have. `QueuedListener` is what a worker can
  resolve; anything in `app/Listeners` is discovered, and `artisan make:listener X
  --event Y --queued` writes one.
- **The event is rebuilt from its class, not handed over as data.** `app/Events` is
  discovered into a registry, and the payload is poured into an instance without
  running the constructor — so `event.label()` and `event instanceof OrderShipped`
  still work inside the worker. An unregistered event still delivers its fields;
  what it loses is exactly those two things.
- **`shouldQueue(event)` is asked in the dispatching process.** That is the only
  place that still has the request's state to decide with.
- **`afterCommit` holds the push until the outermost transaction commits**, and
  drops it entirely if that transaction rolls back. Without it a worker can reserve
  the job first and find none of the rows the event is about. Outside a transaction
  there is nothing to wait for, so it pushes at once.

The dispatcher itself knows nothing about queues: the push arrives as a hook that
`QueueServiceProvider` installs. A queued listener with no queue registered throws
and names the provider — running it in the request would look like it worked.

## @elysian/log

| Missing | Why |
| --- | --- |
| `syslog`, `errorlog`, Slack, Papertrail drivers | `extend()` is the hook; each is a small driver when someone needs it. |
| A deprecation channel | `withContext`/`withoutContext` are on the manager. Routing deprecation notices to a channel of their own needs somewhere for them to come from first — nothing in the framework raises one. |
| `pail`-style live tailing | A `log:tail` command over the file drivers would cover it. |

## @elysian/validation

| Missing | Why |
| --- | --- |
| Rules that need an HTTP request | `FormRequest` lives in `@elysian/http`, where the request and session are. The validator itself works with no HTTP at all, which is why it stays in this package. |
| A wildcard in the *middle* of a `required_if` field reference | Rule keys expand (`items.*.price` runs once per element, nested wildcards included), but a rule that names *another* field — `required_if:items.*.kind,gift` — does not resolve the sibling relative to the element it is running for. Laravel resolves it against the same index; here the field is read as written. |
| `Rule::forEach` | `distinct`, `array:a,b`, `list`, `required_array_keys` and `contains` are implemented on top of the expansion. What is missing is deciding the *rules* per element at runtime, which needs closure rules first. |
| `File::types()->min()` builder objects, `imageFile()` | `file`, `image`, `mimes`, `mimetypes`, `extensions` and `dimensions` are implemented as string rules over the web `File` a multipart body parses to. The fluent builder is sugar over the same strings. |
| `password` (uncompromised), `current_password` | better-auth owns credentials, and neither rule can be checked without asking it to verify a password for the *current* user — a request-scoped question, so it belongs with `FormRequest` rather than with the standalone validator. |
| `date_format`, timezone-aware comparisons | `Date.parse` covers ISO dates; a format parser is its own small project. |
| `Rule::when`, closure rules, custom rule classes | `after()` covers the same ground for now. |
| Translations | Messages are one English catalogue; a translator package would carry the rest. |

Four things to know about file rules:

- **The bytes decide, not the headers.** `image` and `mimes` sniff the file's
  signature; a script renamed `avatar.png` arrives claiming `image/png` and
  nothing else about it disagrees. `extensions` is the opposite rule on purpose —
  it checks the *name* and says nothing about the contents.
- **Only a handful of formats can be sniffed** — PNG, JPEG, GIF, BMP, WebP. For
  anything else `mimes` falls back to the type the client declared, which is a
  claim; `mimetypes:` takes a media type directly, and the extension table is
  deliberately short rather than pretending to cover everything.
- **A size rule on an upload is kilobytes.** `max:2048` is 2MB, matching Laravel,
  and the message says "kilobytes" rather than "characters".
- **Executable extensions are refused unless named.** `mimes:txt` will not accept
  `run.sh` or `x.phar`; `mimes:php` will. Laravel blocks the PHP family the same
  way, widened here to the obvious shell and Windows cases.

Three things to know about wildcard rules:

- **Expansion walks the pattern, it does not filter the data.** `items.*.price`
  against `items: [{ price: 1 }, {}]` produces `items.1.price` even though nothing
  is there — an attribute that does not exist cannot fail `required`, and "you
  forgot the price on the second line" is the whole point.
- **A missing or wrong-typed collection reports itself, once.** With `items`
  absent, `items.*.price` contributes nothing and the rule on `items` is what
  fails. Inventing `items.0.price` would report one problem twice, in a place the
  sender never wrote.
- **`distinct`'s scope is the pattern.** `orders.*.lines.*` compares every line of
  every order against every other, because that is what the pattern names; scoping
  it per order means writing the rule per order.

## @elysian/http

`FormRequest`, `JsonResource`, sessions, signed and encrypted cookies, CSRF, rate
limiting, CORS and trusted proxies.

| Missing | Why |
| --- | --- |
| Encrypting cookies other than the session | Signing and encryption both work, and `SESSION_ENCRYPT=true` encrypts the session cookie, bound to its own name. There is no `EncryptCookies` middleware yet that names a list of cookies to encrypt on the way out and decrypt on the way in; a route that wants one calls `cookies().encrypt(name, value)` itself. |
| A named-route `redirect()->route('articles.show', …)` | `redirect()` takes a path, `back()` resolves the previous URL, and both flash. Named routes do not exist here: Elysia routes are declared as strings on a plugin, so there is no name table to look one up in. |
| `redirect()->guest()` and the intended-URL dance | Needs somewhere to record where the guest was going, which is the login redirect belonging to `@elysian/auth`. |
| A `ViewErrorBag` with **named** bags (`$errors->login->first(...)`) | One bag. Named bags exist for two forms on one page; `errors()` would take the name, and nothing needs it yet. |
| `database` and `redis` session drivers | `file` and `memory` exist; the driver interface is four methods. |
| Typed `session` in a standalone controller | Elysia types a context from the plugins that instance uses, and the derive is registered globally by the provider. `sessionOf(context)` is the single documented narrowing. |
| `Precognition`, `#[RedirectTo]`-style attributes | TypeScript has no runtime attributes; the static flags (`stopOnFirstFailure`, `failOnUnknownFields`) cover the same intent. |
| A `throttle` **route macro** | `throttle()` is an Elysia plugin used inside a controller or a `routeGroup()`, which is how middleware composes here. Laravel's `->middleware('throttle:api')` string form has no equivalent, because routes are not declared through a router object. |
| Per-route CORS | CORS is global and driven by `cors.paths`, as Laravel's `HandleCors` is. A route wanting different origins from its neighbours would need the config keyed by more than a path. |
| `X-Forwarded-Prefix`, AWS ELB's header | `X-Forwarded-For`, `-Proto` and `-Host` are honoured from a trusted proxy. The other two are a branch each when something needs them. |

Three things to know about maintenance mode:

- **The payload is a file, not the cache.** The likeliest moment to need
  maintenance mode is when the database or Redis is the thing that is broken, and a
  mode that cannot be switched on then is not a maintenance mode.
- **`--render` renders when `down` runs**, not per request, and the HTML is stored
  in the payload. The reason to be down is often that the application cannot serve a
  page; asking it to render one then is asking the broken thing to explain itself.
- **The bypass cookie carries a MAC over its own expiry, never the secret.** So a
  copied cookie is a temporary problem rather than a permanent key, and the phrase
  never reaches a browser's history or storage. Visiting the secret URL redirects to
  `/` for the same reason.

Four things to know about the form loop:

- **`errors()` and `old()` read a request scope, not props.** A view here is a JSX
  component, so there is no template scope to share `$errors` into; threading a
  message bag through every component between the handler and the input it belongs
  to is the plumbing that makes people skip validation feedback. The scope is
  entered from a **synchronous** hook, because `enterWith` inside an async `derive`
  is already lost by the time the handler runs.
- **A failure redirects for a browser and 422s for a client**, decided by four
  signals: `X-Requested-With`, `Accept`, a **JSON request body**, and no `Accept` at
  all. The body signal was missing at first, and the playground's API routes started
  receiving redirects they could not follow.
- **A thrown redirect must persist the session; a returned one must not.**
  `onAfterHandle` is what saves, and it does not run on the error path — so a thrown
  redirect saves before throwing. Doing both saves the session twice, which ages the
  flash twice and destroys it before the next request reads it. Both halves were
  found by driving the form over the network.
- **A password is never flashed.** `withInput()` drops `password`,
  `password_confirmation`, `current_password` and `token` at every depth, along with
  uploads, rather than trusting each caller to remember.

Four things to know about the middleware:

- **`throttle()` is scoped to the plugin it is used in.** Putting one on a
  controller limits every route in that file against one budget; a `routeGroup()`
  per limit is how two routes get two budgets. The first draft of the playground
  controller got this wrong and reported one limit's numbers for another limit's
  route.
- **Two windows need two counters.** A named limiter returning
  `[perMinute(3).by(ip), perDay(50).by(ip)]` describes one subject through two
  windows, so the window length is part of the counter key: sharing one counter
  makes every request count twice and the tighter limit trip at half its stated
  number. That happened, and driving it over the network is what showed it. The
  headers report the *tightest* remaining rather than the last one read.
- **A refused CORS request is a normal response without the headers.** Answering
  403 would break same-origin callers of the same route — the browser is what turns
  the absence into an error. A refused origin is told nothing at all: not the
  methods, not the credentials flag, not the max-age.
- **`X-Forwarded-For` is believed only from a proxy you named.** Behind a load
  balancer you must trust it, or one rate limit is shared by the whole internet;
  directly exposed you must not, or a caller forges a fresh identity per request.
  `::ffff:127.0.0.1` is normalised to `127.0.0.1`, because Bun reports an IPv4
  client that way and a limiter comparing against the plain form would silently
  never match — an exemption that never fires being worse than none, since it
  looks like one.

## @elysian/auth

better-auth 1.6.27 owns credentials, sessions, providers and the endpoints that
go with them. This package supplies the adapter that puts its tables on our
connection, the request scope that makes the current user reachable, and the Gate
and policies on top.

| Missing | Why |
| --- | --- |
| **Guest-allowed abilities are opt-in** | Laravel decides from the reflected type of the `$user` parameter whether an ability may run for a guest. TypeScript erases types, so `Gate.define(..., { allowGuests: true })` and a policy's static `allowGuests` say it explicitly. This is a deviation, not an omission. |
| **Policy auto-discovery** | Laravel guesses `App\Policies\XPolicy` and falls back to a `#[UsePolicy]` attribute. Guessing here means scanning the filesystem, and there are no runtime attributes; `gate.policy(Article, ArticlePolicy)` is one line per model. A registered base class does cover its subclasses. |
| **Native SQL joins in the adapter** | better-auth passes a `join` to an adapter only when `experimental.joins` is on, and otherwise emulates it with extra queries. Implementing one would be a second code path to keep correct for no gain today. |
| `many-to-many` joins | Same reason: unreachable until joins are opted into. |
| Auth-table column naming | The tables keep better-auth's own camelCase (`emailVerified`, `userId`) rather than our snake_case. Every plugin declares its `fieldName`s that way, so renaming globally breaks the first plugin added. Application tables are unaffected. |
| Guards and `auth:api` style multi-guard config | There is one session-backed guard, because better-auth models sessions itself. A token guard belongs with its own plugin (`bearer`, `jwt`). |
| `Gate::inspect` on a *response* rendering as HTML | The 403/404 is rendered as JSON by the core exception handler; an HTML error page belongs with the redirect-back work already noted under http. |
| `can` middleware / route-level ability macro | `authorize()` inside a handler covers it and types cleanly across standalone controllers, which is the same reason `sessionOf(context)` exists. |
| Email verification and password-reset mail | better-auth raises the hooks; wiring them to `@elysian/mail` is a small piece of application code rather than framework code, and the playground does not yet show it. |
| `auth:schema` diffing an existing schema | It writes a fresh migration. better-auth's own CLI can diff, but that needs schema introspection wired into the generator — worth doing when the first plugin is added mid-project. |

Two things to know when using it:

- The auth endpoints are registered per HTTP verb rather than through `all()`,
  and the provider must boot *before* the view provider: Elysia treats an `ALL`
  route as a fallback, so the static asset handler's `GET /*` would answer the
  auth endpoints first.
- The request scope is entered from a **synchronous** `onBeforeHandle`.
  `AsyncLocalStorage.enterWith` applies to the rest of the current execution, and
  an `await` restores the frame its continuation was scheduled with — so entering
  the scope inside an async `derive` is lost by the time the handler runs. There
  is a test for this arrangement, because it depends on Elysia not emitting an
  `await` for a synchronous hook.

## @elysian/cache

Four drivers — `array`, `file`, `database`, `redis` — behind one `Repository`, and
one conformance suite that runs against all four (Redis included, against a real
server). The same routes in the playground exercise every driver, because a cache
that behaves differently per driver is worse than none.

| Missing | Why |
| --- | --- |
| **JSON, not a binary format, for stored values** | A `Date` comes back as an ISO string and a class instance loses its identity on every driver except `array`, which stores values as they were given. The trade is deliberate: the payload stays readable in `redis-cli` and in the cache table, and every runtime we target can parse it. Cache plain data, or re-hydrate on read. |
| `memcached`, `dynamodb`, `apc`, `octane` drivers | Nothing in this runtime needs them yet, and `extend()` takes a driver in ten lines. |
| `funnel()` / `ConcurrencyLimiter` | `withoutOverlapping()` covers the common case (one at a time); a semaphore for *N* at a time is a separate primitive. |
| Rate limiter **events** (`RateLimitAttempt`) | The counter and `Limit` live here; naming limiters and applying them is `@elysian/http`, where the request is. Nothing dispatches an event per attempt — a listener would fire on every request, so it needs a reason first. |
| Event classes (`CacheHit`, `KeyWritten`, …) | Events are dispatched as names — `cache.hit`, `cache.written`, `cache.forgotten`, `cache.flushed` — which is how the rest of the framework dispatches. A listener gets the same payload either way. |
| `many()` as one round trip on `file` and `array` | Both read key by key. Redis uses `MGET` and the database store one `where in`, which is where it matters. |

Done since this was written: `flexible()` defers its refresh through core's
`defer()`, so it runs after the response; and `cache:prune` is on a schedule — the
playground registers it hourly.

Two behaviours worth knowing rather than discovering:

- **Tagged entries linger.** Flushing a tag rotates its id, so every key written
  under the old namespace becomes unreachable at once — but the entries stay until
  their own TTL runs out. That is what lets tags work without an index of which
  keys belong to which tag, and it is Laravel's design too.
- **`flush()` on Redis scans this store's prefix** rather than issuing `FLUSHDB`,
  which would take another application's keys with it. With no prefix configured
  there is nothing to scan for, and it does flush the database.

## @elysian/queue

Three drivers — `sync`, `database`, `redis` — a worker whose retry policy is
transcribed step for step from `Illuminate\Queue\Worker`, chains, job middleware,
a failed-job store, and `defer()` for work too small to queue.

| Missing | Why |
| --- | --- |
| **A timeout does not kill the attempt** | Laravel's worker raises a `pcntl` alarm in a forked child. Bun has no way to stop an async function that is already running, so a timeout makes the *worker* stop waiting and fail or retry the job — while the abandoned attempt keeps going in the background. This is the one place where the semantics are genuinely weaker than Laravel's, and it is why `timeout` should be treated as "how long before we give up on you", not "how long before you are stopped". A future `queue:work --isolate` running each job in a child process would close it. |
| **Jobs are identified by class name, not a serialised object** | PHP can `serialize($job)`; TypeScript cannot. The payload carries a name plus the constructor data, and the worker resolves the name through discovery over `app/Jobs`. A job that lives elsewhere has to be registered: `queue().jobs.register(TheJob)`. |
| Batch callbacks as **closures** | `then`/`catch`/`finally` take job classes. Laravel serialises closures into the batch row; a closure cannot be rebuilt in the worker that would run it, which is the same wall queued listeners hit. Naming a job is the honest version, and the callback then gets retries and a failure record like anything else. |
| `Bus::chain()` inside a batch, and a scheduled `batch:prune` | The repository has `prune()`; nothing calls it yet. Chains and batches both exist but do not nest. |
| Per-job `progress` callbacks | `then`, `catch` and `finally` are dispatched. A callback per job needs a reason before it needs an implementation. |
| `queue:listen`, `queue:restart`, Horizon-style supervision | `queue:work` with `--max-jobs`/`--max-time`/`--stop-when-empty` is what a container or a supervisor wants; restarting is the supervisor's job, not ours. |
| `sqs`, `beanstalkd`, `sync`-with-delay | No AWS or Beanstalk client in this runtime yet; `extend()` takes a driver. A delay on `sync` is meaningless — there is nothing to wait in — so it runs immediately rather than blocking the request. |
| Per-property encryption inside a payload | `static encrypted = true` encrypts the whole payload, which is what `ShouldBeEncrypted` does. Encrypting one field and leaving the rest queryable would need a per-property declaration. |
| Rate-limited and overlapping middleware as *attributes* | Both exist as middleware classes returned from `middleware()`; TypeScript has no runtime attributes. |

Five behaviours worth knowing rather than discovering:

- **`maxExceptions` needs a cache.** The count is kept there, keyed by the
  payload's uuid, because it has to survive a release and a different worker
  reserving the job — the payload is rewritten on every release. With no cache
  registered the attempt limit is the only limit.

- **The callbacks are `onSuccess`/`onFailure`/`onFinished`, not
  `then`/`catch`/`finally`.** A class with a `then` member is a thenable, so
  `await queue().batch([...])` would call it with `resolve` and `reject` where job
  classes are expected. The scheduler dropped its own `then()` alias for the same
  reason; here the linter caught it.
- **A batch callback must not belong to its own batch.** Dispatching `then` with
  the batch id in its *payload* makes the batch count its own callback: pending is
  already zero, so finishing the callback finishes the batch again, which
  dispatches another callback, for ever. The id travels in the callback's data
  instead. Found by a test hanging rather than failing.
- **A cancelled batch's jobs are skipped, not deleted.** A driver has no random
  access and another worker may already hold one, so cancellation is checked when a
  job is reserved. A cancelled batch therefore stays unfinished, with a pending
  count for work that will never run — Laravel behaves the same way.
- **`app.handle()` never runs deferred callbacks.** Elysia fires
  `onAfterResponse` when a response is transmitted, and an in-process
  `app.handle()` transmits nothing. A test that needs `defer()` should call
  `flushDeferred()` itself, or drive a real socket — the smoke test does the
  latter.
- **A released job goes to the back of the queue** on the database driver: the row
  is deleted and re-inserted, so it gets a fresh id rather than jumping ahead of
  work that arrived while it was failing.
- **`retryAfter` must exceed your slowest job.** It is how long a reservation is
  trusted; a job still running when it expires will be picked up a second time,
  which is the same trade Laravel makes.

## @elysian/scheduler

A cron matcher written here rather than taken from a package, the frequency helpers
built on top of it, mutexes for overlap and multi-server, and the four commands
that drive it. Nothing runs by itself: a crontab calls `schedule:run` every minute,
or a process runs `schedule:work`.

| Missing | Why |
| --- | --- |
| **`runInBackground` does not fork** | Laravel spawns `php artisan` per entry, so a slow task does not hold the minute. Here every entry runs in the scheduler's own process, one after another: a task that takes two minutes delays the entries behind it. `withoutOverlapping()` keeps the *next minute's* copy of the same task out, which is the part that matters most, and a long task belongs on the queue — `schedule().job(...)` only dispatches, so it returns at once. |
| `sendOutputTo` / `appendOutputTo` / `emailOutputTo` | Output is inherited rather than captured. Capturing is the easy half; the mail package is now here, so this is only waiting for a reason. |
| `#` (nth weekday) and `W` (nearest weekday) in expressions | `L` is supported because `lastDayOfMonth()` needs it. The other two have no helper pointing at them, and each is a special case in the matcher; `dayMatches` is the place to add them. |
| `pingBefore` / `thenPing` | An HTTP call in a hook is one line of application code; a helper for it earns nothing. |
| `then()` as an alias for `after()` | Deliberately absent. An object with a `then` method *is* a thenable, so `await schedule.call(…)` would pass `resolve` in as a hook. A chainable builder must not be mistakable for a promise. |
| `onOneServer` releasing its mutex | Deliberate: the lock is held for the minute, which is what keeps the other servers out. A task that must not run twice in the same minute across servers gets that; one that must never overlap *at all* wants `withoutOverlapping()` too. |

Three things worth knowing:

- **`schedule:test` ignores maintenance mode on purpose.** `schedule:run` skips due
  entries while the application is down unless they declare
  `evenInMaintenanceMode()`; `schedule:test` exists to run one entry *now*, and
  refusing that during maintenance would remove the only way to check a task before
  bringing the site back.
- **`schedule:run` must be called every minute.** It runs what is due *in that
  minute*; calling it every five minutes silently drops four minutes of entries.
  That is cron's contract, not a limitation added here.
- **The day-of-month/day-of-week rule is POSIX's, not the obvious one.** With both
  fields restricted, an expression matches if **either** matches, so
  `0 0 1 * MON` is "the 1st, and every Monday". `matches()` says so, and there is
  a test for it, because the intuitive reading turns a schedule into one that
  almost never runs.

## @elysian/mail

Mailables with an envelope, content and attachments; transports for SMTP, Resend,
Postmark, Mailgun, log and array, plus `failover` and `roundrobin`; queued mail
through the queue package; and `Mail.fake()` for tests.

| Missing | Why |
| --- | --- |
| **SMTP is nodemailer, not ours** | Deliberate. Sending mail is an SMTP state machine *and* a MIME encoder — dot-stuffing, header folding, RFC 2047 words, quoted-printable, multipart boundaries — and every one of those is a place where a subtle bug means mail that silently lands in spam. Laravel delegates the same work to Symfony Mailer. nodemailer is one package with no dependencies of its own and it runs on Bun; what we own is the translation and the tests, including a real SMTP session. |
| Markdown mailables | Needs a markdown parser and a theme to render into. HTML mail here is a JSX view, which is the same renderer the web views use — no second template engine, and the props are typechecked. |
| `ses` transport | SigV4 request signing, which is a package of its own or a hundred lines of crypto. `mail().extend('ses', …)` takes it when it is wanted. |
| Inline images resolved from `cid:` in a preview | The transports pass `cid` through, so embedding works in a real client. Laravel additionally rewrites `cid:` to a data URI when *rendering* for a preview; ours shows the raw reference. |
| `Mail::alwaysFrom` / `alwaysReplyTo` | `alwaysTo` is implemented, because that is the one that prevents an accident. The other two are a config default away. |
| Attachments from a storage disk | Files come from bytes or a path, so `disk('local').path(…)` and `await disk('s3').bytes(…)` both work; the sugar does not exist. |
| `Content` carrying its props type | `content()` returns an erased `Content`, and `viewContent(Component, props)` is where the pairing is checked. A generic return type would force every mailable in an application to agree on one props type. |

Two behaviours worth knowing:

- **`alwaysTo` keeps the originals.** Redirected recipients are written to
  `X-Elysian-To`/`Cc`/`Bcc` rather than dropped, so a message caught on staging can
  still be traced to who it was for.
- **`allowSelfSigned` is refused in production.** The flag exists for a local mail
  catcher; the manager throws rather than honour it where it would mean mail
  readable in transit.

## @elysian/storage

Disks for `local`, `s3` and `memory` behind one contract, with `storage:link`,
streamed downloads and a path guard. The S3 driver is Bun's native client — no SDK,
and presigning needs no network.

| Missing | Why |
| --- | --- |
| `ftp` / `sftp` disks | Neither has a Bun-native client, so each means a dependency. `storage().extend()` takes one in a few lines when it is wanted. |
| `Storage::disk()->response()` as a framework helper on the http side | `fileResponse()` and `download()` return a plain `Response`, which is all a handler needs. There is no `->response()` on the disk itself because a disk should not know about HTTP. |
| `putFileAs` deriving a name from the file's hash | Names are random UUIDs, which do not collide. Content-addressing is a different feature — it deduplicates — and belongs where that is wanted. |
| Per-object visibility on S3 read back from the bucket | `getVisibility()` reports the disk's default. Reading an object's real ACL needs `GetObjectAcl`, which needs a permission most buckets do not grant. |
| `temporaryUploadUrl` on the local disk | There is nothing to sign against: a local file is served by whatever serves the directory. The disk says so rather than inventing a scheme. |
| Attaching a disk file to mail directly | Mail takes `path` or bytes, so `disk('local').path(…)` already works for a local disk, and `await disk('s3').bytes(…)` for a bucket. A `Storage::disk()->attach()` sugar is not there. |
| Directory visibility, `MissingFile` exceptions, chunked/multipart upload helpers | Not needed yet; Bun's S3 writer already does multipart for large writes. |

Three behaviours worth knowing:

- **A path that leaves the disk is refused, not rewritten.** `../../.env`,
  `/etc/passwd` and a `..` that walks out through a symlink all throw
  `PathOutsideDiskError`. Stripping the segments instead would silently turn a
  hostile path into a valid one. There are tests for each, and one that confirms a
  `..` which *stays* inside is still allowed.
- **A missing file reads as `null`; an unreadable directory throws.** The
  distinction is deliberate: a directory nobody has written to yet is a normal
  state, but one that exists and cannot be read is a misconfiguration that should
  not look like "empty".
- **`Content-Disposition` is built defensively.** Quotes, backslashes, CR and LF
  are removed from the filename before it goes in, so a filename cannot close the
  quoted string or split the header; the real name travels in `filename*`.

## @elysian/notifications

One notification, several channels — `mail`, `database` and `log` — with `via()`
deciding per recipient, on-demand recipients, queued delivery, an inbox model and a
fake.

| Missing | Why |
| --- | --- |
| `broadcast` channel | Needs a websocket package, which does not exist yet. It is the one channel that cannot be a few lines of `fetch`. |
| `slack`, `vonage`/SMS channels | Each is one HTTP call and one credential, which makes them a better fit for `notifications().extend()` in an application than a driver in the framework — the playground shows an `sms` channel added that way in the tests. |
| Markdown notification templates | The `MailMessage` builder renders to HTML here, inline-styled, because a mail client ignores most of a stylesheet. `view()` hands the body to one of the application's own JSX components when the default is not enough. |
| `preferredLocale()` / translated notifications | There is no translator package, so there is nothing to switch. |
| `Notifiable` as a model trait with a `notifications()` relation | Recipients satisfy a small interface — `routeNotificationFor`, `getKey`, `getNotifiableType` — rather than inheriting. The inbox is read with an ordinary query on `DatabaseNotification`, which is also what makes `unread()` a database scope instead of a filter in memory. |
| `NotificationSent` as event *classes* | Events are dispatched by name (`notification.sending`, `notification.sent`, `notification.failed`, `notification.skipped`), as everything else in this framework dispatches. |

Three behaviours worth knowing:

- **The id belongs to the delivery, not to the notification object.** Each recipient
  gets its own uuid, shared by every channel it is sent through — that is what lets
  a stored row and the mail about it be correlated. Laravel gets this by cloning the
  notification per recipient; we share one instance, so the id is assigned per
  recipient explicitly. Writing the test for it is what caught the first draft
  handing recipient two the id of recipient one.
- **A failing channel re-throws.** The event is dispatched first, but the error is
  not swallowed: a queued notification that failed silently is a notification
  nobody knows was lost.
- **`database` is skipped for an on-demand recipient.** There is no record for the
  row to belong to, and `route('database', …)` refuses outright rather than writing
  an orphan.

## @elysian/encryption

| Missing | Why |
| --- | --- |
| `Crypt::extend`, a driver other than AES-256-GCM | One AEAD, chosen and versioned, rather than a choice a caller can get wrong. Laravel still carries CBC+HMAC for compatibility; there is nothing here to be compatible with. The payload's `v1.` prefix is how a second algorithm would arrive without breaking what is already written. |
| Reading Laravel's own payload format | A Laravel payload is base64 JSON with `iv`/`value`/`mac`/`tag`. Nothing shares a database with a Laravel app yet, so decoding it would be dead code; if that changes it is a second reader behind the version prefix. |
| Asymmetric keys, signing, envelope encryption, a KMS | Different problem: this package protects data at rest with a key the app already has. A KMS-backed key would slot in behind `deriveKey`. |
| Rewriting stored ciphertexts after a rotation | `APP_PREVIOUS_KEYS` keeps old payloads readable indefinitely, which is enough to rotate without downtime, but nothing walks the tables to re-encrypt them onto the new key. That is a per-model migration. |

Five decisions worth knowing rather than discovering:

- **One AEAD does both jobs.** GCM encrypts and authenticates in one pass, so
  there is no separate MAC to compare and no order-of-operations mistake to make.
  `node:crypto` in Bun enforces the tag, and it is synchronous, so encryption is
  not an `await` in the middle of an accessor.
- **Keys are derived, never used raw.** HKDF with a purpose string means the cookie
  *signer* and the *encrypter* never share key material, even though both come from
  `APP_KEY`. Compromising one does not hand over the other.
- **Context is authenticated, not carried.** `encrypt(value, 'cookie:remember')`
  binds the purpose into the tag: the payload does not grow, the context does not
  leak, and lifting a value from one cookie into another fails to decrypt rather
  than merely looking odd. This is what Laravel's HMAC-of-the-cookie-name prefix
  buys, without the bytes or the stripping.
- **Every failure reads the same.** A caller is told "Could not decrypt the
  payload." whether the version, the length, the tag, the context or the key was
  wrong. Distinguishing them is how a padding-oracle-shaped attack starts.
- **`session.encrypt` without the provider warns.** The cookie falls back to being
  signed rather than failing the boot, but it says so through the log: silently
  degrading would leave somebody believing a cookie is encrypted when it is not.
- **Encrypting a column costs you querying it.** `where('editor_note', …)` cannot
  match a ciphertext, and no amount of care changes that — a fresh nonce per write
  means the same plaintext never produces the same bytes twice. Encrypt what you
  read, not what you search by.

## create-elysian

The template ships **all 17 packages** and a scaffolded application registers
every provider, with the drivers that need no service behind them — `cache=file`,
`queue=sync`, `mail=log`, `disk=local`, SQLite — so `bun run dev` works before
Docker does.

| Missing | Why |
| --- | --- |
| Starter kits (Breeze/Jetstream-shaped) | The template is one landing page. Auth *endpoints* are mounted and better-auth is a dependency, but there is no sign-in view, no dashboard and no scaffolding switch that writes them. |
| A `sessions` table generator | There is no `database` session driver yet (see `@elysian/http`), so `session:table` would write a migration nothing reads. |
| Publishing to npm | `bun create elysian my-app` cannot work until `create-elysian` is on npm; the README says so rather than implying it. |
| `--kit`/`--minimal` variants | One template, so nothing to choose between. A minimal variant would mean maintaining two. |

One thing worth knowing, and two worth remembering:

- **No migrations ship in the box.** Laravel's skeleton carries `users`, `cache`
  and `jobs`; better-auth's tables depend on `config/auth.ts`, so they are
  generated with `auth:schema`, and the rest are only needed when a driver changes.
  `create-elysian` prints those steps rather than assuming them.

- **The template drifted for eight packages and nothing noticed.** Every package
  was exercised by the playground, where the wiring was written by hand, so a new
  application silently lacked half the framework while every test passed. Its
  `config/session.ts` also told a new application that cookies are signed "rather
  than encrypted" long after that stopped being true.
- **What catches it now is registration.** The smoke run boots a scaffolded
  application and asserts that a command from each package appears in `artisan
  list` — a command only appears if its provider booted, which needs the
  dependency, the provider entry and the config file all present. A ninth package
  that forgets the template fails there.

## Not started

Every package on the roadmap is built — core, console, view, events, log,
database, validation, http, auth, cache, queue, scheduler, mail, storage,
notifications, and the encryption package the last three items were waiting on.

Delivery is done too: the scaffolder ships all of them, and a scaffolded
application boots every provider without a service running. What remains is in
the per-package tables above — starter-kit views being the largest of it.

## Watch list

- `node_modules/.bun` holds **two copies of elysia 1.4.29** under different peer
  hashes. Nothing misbehaves today, but dual module identity is exactly what the
  `file:`-dependency episode was about, and Elysia deduplicates plugins by name
  within one module instance. Worth collapsing if plugin registration ever gets
  strange.

## Test coverage gaps

`bun test --coverage` reports roughly three quarters of functions. Known
uncovered, and why:

- terminal formatting (`output.ts`, `about.ts`, `db:show`, `db:table`) — the
  smoke test asserts the text that matters; pinning colour codes would test
  `picocolors`
- `serve.ts` — its `handle()` never resolves by design; the smoke test binds a
  real socket instead
- `create-elysian` — covered end to end by the smoke test rather than by units:
  it scaffolds, boots, and every package's commands are registered in what it
  wrote. Not covered is a scaffold installed *from npm* rather than resolved
  through the workspace
- MySQL/Postgres **grammar** paths that the dialect suite does not reach, such as
  `insertGetId` on MariaDB
- the S3 disk against AWS itself — the round trip is covered against MinIO
  (`TEST_S3_ENDPOINT`), which is the same protocol, but not against S3's own
  eventual-consistency and region behaviour
- the queue's `redis` driver against a cluster; single-node Redis is covered, and
  the database driver is covered on SQLite, Postgres 17 and MySQL 9 including the
  two-workers-race case that only a real server can exercise
- the cache's `database` driver against Postgres and MySQL — the conformance
  suite runs it on SQLite, and the upsert and `for update` paths it relies on are
  covered for those dialects by the database package's own suite
- better-auth **plugin** schemas against real servers — the adapter itself is
  covered on SQLite, Postgres 17 and MySQL 9 by `packages/auth/test/dialects.test.ts`,
  but only for the four core tables
