# Known gaps

What is deliberately missing, per package, so it is not rediscovered by
accident. Everything here is a decision, not an oversight; where something was
attempted and could not be made to work, that is said plainly.

**A row is removed when the thing is built, or narrowed when part of it is.**
Implementing `morphToMany` left "a morph map for the type"; implementing batches
left "chains inside a batch". A narrowed row is the list getting more precise —
but it does mean closing something does not always shorten the list, so the
count alone is a poor measure of progress.

**A row whose answer is "this is not actually missing" does not belong here.**
Eight have been written and then removed on those grounds; the last four named
`FormRequest`, `sessionOf()`, `fileResponse()` and a transaction arrangement that
already works. Behaviour that exists and is merely surprising belongs in
`BEHAVIOURS.md`, which is where the per-package notes moved so that this file
shortens when work is finished.

Reviewed against the Laravel 13 documentation and, where behaviour mattered, the
`laravel/framework` source.

Every row was last checked against the code on 2026-08-13: each one's API was
grepped for in `packages/*/src`. Rows that named something already implemented
were removed — `Model::withoutTimestamps`, `Log::withoutContext`,
`connection.transactions.level`, a duplicate pair about console prompting, and
the four named above.

---

## @elysian/database — complete for this milestone

The query builder, schema builder, migrator and model layer cover the documented
Laravel surface that applies to this runtime, and are tested against **SQLite,
Postgres 17 and MySQL 9**.

Deliberately absent, with reasons:

| Missing | Why |
| --- | --- |
| Queued jobs *from a model* (`$model->notify()`-shaped sugar) | The queue exists and queued listeners now run through it; what is missing is sugar on the model itself. A model's lifecycle events are dispatched, so a queued listener on `model.created` already covers it. |
| Choosing a replica by anything but chance | A `read` list is picked from at random, as Laravel does. Weighting by lag or by load needs something that measures either. |
| Database transactions across connections (2PC) | `Bun.SQL` exposes `beginDistributed`, so this is reachable — no design obstacle, just unbuilt. |
| Vector/similarity clauses (pgvector) | Needs its own grammar and the pgvector extension. |
| `morphToMany` **through** another relation | Reaching a morph pivot via a second relation is a join shape nothing here composes yet. |
| `ofMany()` with a **closure** aggregate, and multi-column tie-breaks | `latestOfMany`/`oldestOfMany` take one column and break ties on the key, which is the pair Laravel's own helpers produce. An arbitrary aggregate, or ordering by two columns before the key, needs the general `ofMany` form. |
| `touchIfTouching` guessing the **inverse** relation | Laravel infers the inverse relation's name from the class name; here the pairing must be written down. |
| Custom encrypted cast keys, searchable ciphertext | The `encrypted` and `encrypted:json` casts are implemented over `@elysian/encryption`. What is missing is a blind index — a deterministic hash column you can search by — which is the only way to query an encrypted column and needs a schema decision per table. |
| `migrate --isolated`, `--squash`, `schema:dump` | Needs an advisory lock and a schema dumper per dialect. |

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

## @elysian/log

| Missing | Why |
| --- | --- |
| `syslog`, `errorlog`, Slack, Papertrail drivers | `extend()` is the hook; each is a small driver when someone needs it. |
| A deprecation channel | `withContext`/`withoutContext` are on the manager. Routing deprecation notices to a channel of their own needs somewhere for them to come from first — nothing in the framework raises one. |
| `pail`-style live tailing | A `log:tail` command over the file drivers would cover it. |

## @elysian/validation

| Missing | Why |
| --- | --- |
| A wildcard in the *middle* of a `required_if` field reference | Rule keys expand (`items.*.price` runs once per element, nested wildcards included), but a rule that names *another* field — `required_if:items.*.kind,gift` — does not resolve the sibling relative to the element it is running for. Laravel resolves it against the same index; here the field is read as written. |
| `Rule::forEach` | `distinct`, `array:a,b`, `list`, `required_array_keys` and `contains` are implemented on top of the expansion. What is missing is deciding the *rules* per element at runtime, which needs closure rules first. |
| `File::types()->min()` builder objects, `imageFile()` | `file`, `image`, `mimes`, `mimetypes`, `extensions` and `dimensions` are implemented as string rules over the web `File` a multipart body parses to. The fluent builder is sugar over the same strings. |
| `password` (uncompromised), `current_password` | better-auth owns credentials, and neither rule can be checked without asking it to verify a password for the *current* user — a request-scoped question, so it belongs with `FormRequest` rather than with the standalone validator. |
| `date_format`, timezone-aware comparisons | `Date.parse` covers ISO dates; a format parser is its own small project. |
| `Rule::when`, closure rules, custom rule classes | `after()` covers the same ground for now. |
| Translations | Messages are one English catalogue; a translator package would carry the rest. |

## @elysian/http

`FormRequest`, `JsonResource`, sessions, signed and encrypted cookies, CSRF, rate
limiting, CORS and trusted proxies.

| Missing | Why |
| --- | --- |
| A named-route `redirect()->route('articles.show', …)` | `redirect()` takes a path, `back()` resolves the previous URL, and both flash. Named routes do not exist here: Elysia routes are declared as strings on a plugin, so there is no name table to look one up in. |
| `Precognition`, `#[RedirectTo]`-style attributes | TypeScript has no runtime attributes; the static flags (`stopOnFirstFailure`, `failOnUnknownFields`) cover the same intent. |
| A `throttle` **route macro** | `throttle()` is an Elysia plugin used inside a controller or a `routeGroup()`, which is how middleware composes here. Laravel's `->middleware('throttle:api')` string form has no equivalent, because routes are not declared through a router object. |
| Per-route CORS | CORS is global and driven by `cors.paths`, as Laravel's `HandleCors` is. A route wanting different origins from its neighbours would need the config keyed by more than a path. |

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
| `auth:schema` diffing an existing schema | It writes a fresh migration. better-auth's own CLI can diff, but that needs schema introspection wired into the generator — worth doing when the first plugin is added mid-project. |

## @elysian/cache

Four drivers — `array`, `file`, `database`, `redis` — behind one `Repository`, and
one conformance suite that runs against all four (Redis included, against a real
server). The same routes in the playground exercise every driver, because a cache
that behaves differently per driver is worse than none.

| Missing | Why |
| --- | --- |
| **JSON, not a binary format, for stored values** | A `Date` comes back as an ISO string and a class instance loses its identity on every driver except `array`, which stores values as they were given. The trade is deliberate: the payload stays readable in `redis-cli` and in the cache table, and every runtime we target can parse it. Cache plain data, or re-hydrate on read. |
| `memcached`, `dynamodb`, `apc`, `octane` drivers | Nothing in this runtime needs them yet, and `extend()` takes a driver in ten lines. |
| Rate limiter **events** (`RateLimitAttempt`) | The counter and `Limit` live here; naming limiters and applying them is `@elysian/http`, where the request is. Nothing dispatches an event per attempt — a listener would fire on every request, so it needs a reason first. |
| Event classes (`CacheHit`, `KeyWritten`, …) | Events are dispatched as names — `cache.hit`, `cache.written`, `cache.forgotten`, `cache.flushed` — which is how the rest of the framework dispatches. A listener gets the same payload either way. |
| `many()` as one round trip on `file` and `array` | Both read key by key. Redis uses `MGET` and the database store one `where in`, which is where it matters. |

Done since this was written: `flexible()` defers its refresh through core's
`defer()`, so it runs after the response; and `cache:prune` is on a schedule — the
playground registers it hourly.

## @elysian/queue

Three drivers — `sync`, `database`, `redis` — a worker whose retry policy is
transcribed step for step from `Illuminate\Queue\Worker`, chains, job middleware,
a failed-job store, and `defer()` for work too small to queue.

| Missing | Why |
| --- | --- |
| **A timeout does not kill the attempt** | Laravel's worker raises a `pcntl` alarm in a forked child. Bun has no way to stop an async function that is already running, so a timeout makes the *worker* stop waiting and fail or retry the job — while the abandoned attempt keeps going in the background. This is the one place where the semantics are genuinely weaker than Laravel's, and it is why `timeout` should be treated as "how long before we give up on you", not "how long before you are stopped". A future `queue:work --isolate` running each job in a child process would close it. |
| **Jobs are identified by class name, not a serialised object** | PHP can `serialize($job)`; TypeScript cannot. The payload carries a name plus the constructor data, and the worker resolves the name through discovery over `app/Jobs`. A job that lives elsewhere has to be registered: `queue().jobs.register(TheJob)`. |
| Batch callbacks as **closures** | `then`/`catch`/`finally` take job classes. Laravel serialises closures into the batch row; a closure cannot be rebuilt in the worker that would run it, which is the same wall queued listeners hit. Naming a job is the honest version, and the callback then gets retries and a failure record like anything else. |
| Per-job `progress` callbacks | `then`, `catch` and `finally` are dispatched. A callback per job needs a reason before it needs an implementation. |
| `queue:listen`, `queue:restart`, Horizon-style supervision | `queue:work` with `--max-jobs`/`--max-time`/`--stop-when-empty` is what a container or a supervisor wants; restarting is the supervisor's job, not ours. |
| `beanstalkd`, `sync`-with-delay | No Beanstalk client in this runtime; `extend()` takes a driver. A delay on `sync` is meaningless — there is nothing to wait in — so it runs immediately rather than blocking the request. |
| Per-property encryption inside a payload | `static encrypted = true` encrypts the whole payload, which is what `ShouldBeEncrypted` does. Encrypting one field and leaving the rest queryable would need a per-property declaration. |
| Rate-limited and overlapping middleware as *attributes* | Both exist as middleware classes returned from `middleware()`; TypeScript has no runtime attributes. |

## @elysian/scheduler

A cron matcher written here rather than taken from a package, the frequency helpers
built on top of it, mutexes for overlap and multi-server, and the four commands
that drive it. Nothing runs by itself: a crontab calls `schedule:run` every minute,
or a process runs `schedule:work`.

| Missing | Why |
| --- | --- |
| A background run that outlives its minute | `runInBackground()` forks the entry, so the entries *behind* it no longer wait. What still waits is `schedule:run` itself, which holds until its children exit — otherwise the process leaves with the overlap mutex unreleased and `onSuccess` never fired. Laravel avoids that by having the child call `schedule:finish`; here a task that runs longer than a minute therefore delays the next tick of `schedule:work`. A long task still belongs on the queue. |
| `sendOutputTo` / `appendOutputTo` / `emailOutputTo` | A forked entry inherits stdout rather than capturing it, so a background task's logging still reaches wherever the scheduler's does. Capturing it is a pipe away now that entries fork; there is nothing to redirect it *to* until one of these exists. |
| `#` (nth weekday) and `W` (nearest weekday) in expressions | `L` is supported because `lastDayOfMonth()` needs it. The other two have no helper pointing at them, and each is a special case in the matcher; `dayMatches` is the place to add them. |
| `pingBefore` / `thenPing` | An HTTP call in a hook is one line of application code; a helper for it earns nothing. |
| `then()` as an alias for `after()` | Deliberately absent. An object with a `then` method *is* a thenable, so `await schedule.call(…)` would pass `resolve` in as a hook. A chainable builder must not be mistakable for a promise. |
| `onOneServer` releasing its mutex | Deliberate: the lock is held for the minute, which is what keeps the other servers out. A task that must not run twice in the same minute across servers gets that; one that must never overlap *at all* wants `withoutOverlapping()` too. |

## @elysian/mail

Mailables with an envelope, content and attachments; transports for SMTP, Resend,
Postmark, Mailgun, log and array, plus `failover` and `roundrobin`; queued mail
through the queue package; and `Mail.fake()` for tests.

| Missing | Why |
| --- | --- |
| **SMTP is nodemailer, not ours** | Deliberate. Sending mail is an SMTP state machine *and* a MIME encoder — dot-stuffing, header folding, RFC 2047 words, quoted-printable, multipart boundaries — and every one of those is a place where a subtle bug means mail that silently lands in spam. Laravel delegates the same work to Symfony Mailer. nodemailer is one package with no dependencies of its own and it runs on Bun; what we own is the translation and the tests, including a real SMTP session. |
| Markdown mailables | Needs a markdown parser and a theme to render into. HTML mail here is a JSX view, which is the same renderer the web views use — no second template engine, and the props are typechecked. |
| `Content` carrying its props type | `content()` returns an erased `Content`, and `viewContent(Component, props)` is where the pairing is checked. A generic return type would force every mailable in an application to agree on one props type. |

## @elysian/storage

Disks for `local`, `s3` and `memory` behind one contract, with `storage:link`,
streamed downloads and a path guard. The S3 driver is Bun's native client — no SDK,
and presigning needs no network.

| Missing | Why |
| --- | --- |
| `ftp` / `sftp` disks | Neither has a Bun-native client, so each means a dependency. `storage().extend()` takes one in a few lines when it is wanted. |
| `putFileAs` deriving a name from the file's hash | Names are random UUIDs, which do not collide. Content-addressing is a different feature — it deduplicates — and belongs where that is wanted. |
| `temporaryUploadUrl` on the local disk | There is nothing to sign against: a local file is served by whatever serves the directory. The disk says so rather than inventing a scheme. |
| Directory visibility, `MissingFile` exceptions, chunked/multipart upload helpers | Not needed yet; Bun's S3 writer already does multipart for large writes. |

## @elysian/notifications

One notification, several channels — `mail`, `database` and `log` — with `via()`
deciding per recipient, on-demand recipients, queued delivery, an inbox model and a
fake.

| Missing | Why |
| --- | --- |
| `broadcast` channel | Needs a websocket package, which does not exist yet. It is the one channel that cannot be a few lines of `fetch`. |
| `slack`, `vonage`/SMS channels | Each is one HTTP call and one credential, which makes them a better fit for `notifications().extend()` in an application than a driver in the framework — the package's tests show an `sms` channel added that way. |
| Markdown notification templates | The `MailMessage` builder renders to HTML here, inline-styled, because a mail client ignores most of a stylesheet. `view()` hands the body to one of the application's own JSX components when the default is not enough. |
| `preferredLocale()` / translated notifications | There is no translator package, so there is nothing to switch. |
| `Notifiable` as a model trait with a `notifications()` relation | Recipients satisfy a small interface — `routeNotificationFor`, `getKey`, `getNotifiableType` — rather than inheriting. The inbox is read with an ordinary query on `DatabaseNotification`, which is also what makes `unread()` a database scope instead of a filter in memory. |
| `NotificationSent` as event *classes* | Events are dispatched by name (`notification.sending`, `notification.sent`, `notification.failed`, `notification.skipped`), as everything else in this framework dispatches. |

## @elysian/encryption

| Missing | Why |
| --- | --- |
| `Crypt::extend`, a driver other than AES-256-GCM | One AEAD, chosen and versioned, rather than a choice a caller can get wrong. Laravel still carries CBC+HMAC for compatibility; there is nothing here to be compatible with. The payload's `v1.` prefix is how a second algorithm would arrive without breaking what is already written. |
| Reading Laravel's own payload format | A Laravel payload is base64 JSON with `iv`/`value`/`mac`/`tag`. Nothing shares a database with a Laravel app yet, so decoding it would be dead code; if that changes it is a second reader behind the version prefix. |
| Asymmetric keys, signing, envelope encryption, a KMS | Different problem: this package protects data at rest with a key the app already has. A KMS-backed key would slot in behind `deriveKey`. |
| Rewriting stored ciphertexts after a rotation | `APP_PREVIOUS_KEYS` keeps old payloads readable indefinitely, which is enough to rotate without downtime, but nothing walks the tables to re-encrypt them onto the new key. That is a per-model migration. |

## create-elysian

The template ships **all 17 packages** and a scaffolded application registers
every provider, with the drivers that need no service behind them — `cache=file`,
`queue=sync`, `mail=log`, `disk=local`, SQLite — so `bun run dev` works before
Docker does.

| Missing | Why |
| --- | --- |
| Starter kits (Breeze/Jetstream-shaped) | The template is one landing page. Auth *endpoints* are mounted and better-auth is a dependency, but there is no sign-in view, no dashboard and no scaffolding switch that writes them. |
| Publishing to npm | `bun create elysian my-app` cannot work until `create-elysian` is on npm; the README says so rather than implying it. |
| `--kit`/`--minimal` variants | One template, so nothing to choose between. A minimal variant would mean maintaining two. |

## Not started

Every package on the roadmap is built — core, console, view, events, log,
database, validation, http, auth, cache, queue, scheduler, mail, storage,
notifications, and the encryption package the last three items were waiting on.

Delivery is done too: the scaffolder ships all of them, and a scaffolded
application boots every provider without a service running. What remains is in
the per-package tables above — starter-kit views being the largest of it.

## Watch list

- **`sessions.last_activity` is a 32-bit integer**, like Laravel's. It holds a
  unix timestamp, so it is correct until 2038 and then it is not — the same shape
  as the cache's `expiration` bug that Postgres and MySQL caught. Left alone for
  now because nothing writes a value beyond the range today; worth widening the
  next time that table changes.
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
- the `sqs` driver against AWS itself — the round trip is covered against
  ElasticMQ, which speaks the same query protocol and the same SigV4, but not
  against AWS's own eventual consistency, its 120,000 in-flight limit, or FIFO
  queues
- the queue's `redis` driver against a cluster; single-node Redis is covered, and
  the database driver is covered on SQLite, Postgres 17 and MySQL 9 including the
  two-workers-race case that only a real server can exercise
- better-auth **plugin** schemas against real servers — the adapter itself is
  covered on SQLite, Postgres 17 and MySQL 9 by `packages/auth/test/dialects.test.ts`,
  but only for the four core tables
