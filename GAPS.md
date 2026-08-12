# Known gaps

What is deliberately missing, per package, so it is not rediscovered by
accident. Everything here is a decision, not an oversight; where something was
attempted and could not be made to work, that is said plainly.

Reviewed against the Laravel 13 documentation and, where behaviour mattered, the
`laravel/framework` source.

---

## @elysian/database — complete for this milestone

The query builder, schema builder, migrator and model layer cover the documented
Laravel surface that applies to this runtime, and are tested against **SQLite,
Postgres 17 and MySQL 9**.

Deliberately absent, with reasons:

| Missing | Why |
| --- | --- |
| Queued anything (`ShouldQueue` listeners, queued jobs from models) | The queue package does not exist. A synchronous fallback that calls itself queued would be a lie. |
| Read/write connection splitting, sticky connections | Needs a second connection per config entry and a read/write router; worth doing when someone has a replica. `ConnectionManager` already keys connections by name, so this is additive. |
| Database transactions across connections (2PC) | `Bun.SQL` exposes `beginDistributed`, so this is reachable — no design obstacle, just unbuilt. |
| `whereFullText`, vector/similarity clauses | Dialect-specific and rarely portable; Postgres `tsvector`, MySQL `MATCH`, and pgvector all need their own grammar. |
| JSON path wheres (`whereJsonContains`, `->>` updates) | Three incompatible syntaxes (`json_extract`, `->>`, `jsonb`). Needs a grammar method per dialect to be correct rather than approximately correct. |
| `Schema::hasIndex`, column *modification* (`->change()`) | Changing a column is not portable: SQLite requires a table rebuild. Adding, dropping and renaming columns are supported. |
| `morphedByMany` / `morphToMany` | `morphTo`, `morphOne`, `morphMany` and `belongsToMany` are done; the many-to-many morph needs a pivot with a type column. |
| `hasOneThrough`, `latestOfMany`/`oldestOfMany` | `hasManyThrough` is done; these are variations on it. |
| Pivot **models** (`using()`), pivot timestamps, `withPivot` columns | Pivot rows are read as plain columns. Attach/detach/sync/toggle/updateExistingPivot work. |
| Model observers as classes | Lifecycle events are dispatched (`model.created` etc) through `@elysian/events`, so a listener can already react. There is no `Observer` class binding sugar. |
| `chunkById`, cursor pagination | `chunk()` and `lazy()` are implemented with offset paging, which is correct but slower on large tables and can skip rows if the set changes mid-walk. |
| `Model::withoutEvents`, `saveQuietly` | Straightforward once needed. |
| Custom cast classes (`CastsAttributes`) | Casts are the built-in set plus accessors/mutators, which covers the same ground with less machinery. |
| Custom encrypted cast keys, searchable ciphertext | The `encrypted` and `encrypted:json` casts are implemented over `@elysian/encryption`. What is missing is a blind index — a deterministic hash column you can search by — which is the only way to query an encrypted column and needs a schema decision per table. |
| `DB::listen` as a public helper | Every query already dispatches `QueryExecuted`; a listener on `db.query` is the same thing without a new API. |
| `migrate --isolated`, `--squash`, `schema:dump` | Needs an advisory lock and a schema dumper per dialect. |

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
| Maintenance mode (`down`/`up`) | Needs a request middleware and a flag file. |
| `terminate` callbacks / graceful shutdown hooks | `booted()` exists; the mirror on shutdown does not. |

## @elysian/console

| Missing | Why |
| --- | --- |
| Task scheduling (`schedule:run`, cron expressions) | A scheduler needs a long-running process and overlap locks; belongs with the queue work. |
| Prompting for missing required arguments | The parser fails with `missing: "name"` instead. `@clack/prompts` is already a dependency, so this is small. |
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

| Missing | Why |
| --- | --- |
| Queued listeners, `ShouldQueue`, `afterCommit` | Needs the queue package and a transaction manager. |
| Broadcasting | Needs a driver and a socket layer. |
| Interface-based listeners (`addInterfaceListeners`) | Class events are matched by name; an interface has no runtime identity in TypeScript. |

## @elysian/log

| Missing | Why |
| --- | --- |
| `syslog`, `errorlog`, Slack, Papertrail drivers | `extend()` is the hook; each is a small driver when someone needs it. |
| Log deprecation channel, `Log::withoutContext` on the manager | Minor surface. |
| `pail`-style live tailing | A `log:tail` command over the file drivers would cover it. |

## @elysian/validation

| Missing | Why |
| --- | --- |
| `FormRequest` | Needs the request context and session, so it belongs to `http`. The validator itself works with no HTTP at all. |
| Array/wildcard rules (`items.*.price`) | Needs the attribute expander that turns one rule into one per index; the dot-notation reader is already there. |
| `distinct`, `array_keys`, `contains` | Depend on the wildcard expansion above. |
| File rules (`file`, `image`, `mimes`, `dimensions`) | Belong with request handling, where an upload actually exists. |
| `password` (uncompromised), `current_password` | Need the hashing and auth packages. |
| `date_format`, timezone-aware comparisons | `Date.parse` covers ISO dates; a format parser is its own small project. |
| `Rule::when`, closure rules, custom rule classes | `after()` covers the same ground for now. |
| Translations | Messages are one English catalogue; a translator package would carry the rest. |

## @elysian/http

| Missing | Why |
| --- | --- |
| Encrypting cookies other than the session | Signing and encryption both work, and `SESSION_ENCRYPT=true` encrypts the session cookie, bound to its own name. There is no `EncryptCookies` middleware yet that names a list of cookies to encrypt on the way out and decrypt on the way in; a route that wants one calls `cookies().encrypt(name, value)` itself. |
| Redirect-back-with-errors (`back()->withErrors()`) | Sessions and flash data are in place, so this is a redirect helper plus an `$errors` view global — small, but it belongs with a form-rendering example. |
| `database` and `redis` session drivers | `file` and `memory` exist; the driver interface is four methods. |
| Typed `session` in a standalone controller | Elysia types a context from the plugins that instance uses, and the derive is registered globally by the provider. `sessionOf(context)` is the single documented narrowing. |
| `Precognition`, `#[RedirectTo]`-style attributes | TypeScript has no runtime attributes; the static flags (`stopOnFirstFailure`, `failOnUnknownFields`) cover the same intent. |
| Rate limiting, trusted proxies, CORS | Separate middleware, none of it started. |

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
| Named rate limiters (`RateLimiter::for('uploads', …)`) and the `throttle` middleware | The limiter itself is complete; naming limits and applying them per route is HTTP work, and lands with the middleware in `@elysian/http`. |
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
| `Bus::batch()` | Batches need their own table, progress tracking, and completion callbacks — a milestone of its own. Chains are implemented, which covers "run these in order". |
| `maxExceptions` | Carried in the payload and honoured by the payload contract, but not yet counted: Laravel counts exceptions in the cache per job uuid. The attempt limit and `retryUntil` both work. |
| `queue:listen`, `queue:restart`, Horizon-style supervision | `queue:work` with `--max-jobs`/`--max-time`/`--stop-when-empty` is what a container or a supervisor wants; restarting is the supervisor's job, not ours. |
| `sqs`, `beanstalkd`, `sync`-with-delay | No AWS or Beanstalk client in this runtime yet; `extend()` takes a driver. A delay on `sync` is meaningless — there is nothing to wait in — so it runs immediately rather than blocking the request. |
| Per-property encryption inside a payload | `static encrypted = true` encrypts the whole payload, which is what `ShouldBeEncrypted` does. Encrypting one field and leaving the rest queryable would need a per-property declaration. |
| Rate-limited and overlapping middleware as *attributes* | Both exist as middleware classes returned from `middleware()`; TypeScript has no runtime attributes. |

Three behaviours worth knowing rather than discovering:

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
| Maintenance-mode awareness (`evenInMaintenanceMode`) | There is no maintenance mode yet — that is `down`/`up` commands and a middleware, and it belongs with them. |

Two things worth knowing:

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

**The scaffolder ships 10 of the 17 packages.** This is the largest gap in the
project and the one least visible from inside it: every package is exercised by
the playground, where the wiring was written by hand, so nothing fails — while an
application scaffolded today cannot use half the framework without hand-wiring it.

| Missing from the template | Consequence |
| --- | --- |
| `@elysian/auth`, `cache`, `queue`, `scheduler`, `mail`, `storage`, `notifications`, `encryption` in `_package.json` | Eight packages a new application has to add itself, with the version pinning the scaffolder otherwise handles. |
| The same eight in `config/app.ts` providers | Nothing is bound, so `cache()`, `dispatch()`, `notify()`, `encrypt()` throw in a fresh application. |
| `config/auth.ts`, `cache.ts`, `queue.ts`, `mail.ts`, `filesystems.ts`, `notifications.ts` | Only `app`, `database`, `logging`, `session`, `view` are written. The rest exist in `playground/config/` only. |
| The env keys those configs read, in `_env.example` | `CACHE_STORE`, `QUEUE_CONNECTION`, `MAIL_MAILER`, `FILESYSTEM_DISK`, `APP_PREVIOUS_KEYS`, `SESSION_ENCRYPT` and the rest are absent. |
| Migrations for `jobs`, `failed_jobs`, `cache`, `notifications` and the auth tables | Not actually missing: `queue:table`, `queue:failed-table`, `cache:table`, `notifications:table` and `auth:schema` write them on demand, which is how Laravel ships them too. What a new application lacks is being *told* it needs to run one when it switches a driver to `database`. |
| A `sessions` table generator | There is no `database` session driver yet (see `@elysian/http`), so `session:table` would write a migration nothing reads. |

The template also **drifts silently**: its `config/session.ts` still told a new
application that cookies are signed "rather than encrypted" for as long as it took
somebody to read it, which was fixed only because the encryption work happened to
touch that sentence. Nothing checks the template against the packages — the smoke
test asserts that a scaffolded application *scaffolds*, not that it can boot every
provider the framework offers.

## Not started

Every package on the roadmap is built — core, console, view, events, log,
database, validation, http, auth, cache, queue, scheduler, mail, storage,
notifications, and the encryption package the last three items were waiting on.

What is *not* done is delivery: the scaffolder lags eight packages behind the
framework, which is the section above and the next piece of work. The rest of
what is deliberately missing is in the per-package tables.

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
- `create-elysian` — covered end to end by the smoke test rather than by units,
  and only that it *scaffolds*: nothing asserts the template stays level with the
  packages, which is how the drift in the section above went unnoticed
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
