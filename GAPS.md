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
| Attribute encryption | Needs the encryption package. |
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
| **Encrypted cookies** | Signing is implemented; encryption needs an encryption package. Stated in the README rather than implied, and the encrypted `X-XSRF-TOKEN` header is rejected rather than silently accepted. |
| Redirect-back-with-errors (`back()->withErrors()`) | Sessions and flash data are in place, so this is a redirect helper plus an `$errors` view global — small, but it belongs with a form-rendering example. |
| `database` and `redis` session drivers | `file` and `memory` exist; the driver interface is four methods. |
| Session garbage collection on a schedule | `gc(lifetime)` exists on both drivers; nothing calls it yet — that wants the scheduler. |
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
| Email verification and password-reset mail | better-auth raises the hooks; sending needs the mail package. |
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
| `flexible()` deferring until after the response | Laravel defers the refresh with `defer()`, which runs it once the response is sent. Ours starts it immediately and does not await it — the requester still does not wait, but the process does the work sooner. A real `defer()` belongs with the queue package. |
| `funnel()` / `ConcurrencyLimiter` | `withoutOverlapping()` covers the common case (one at a time); a semaphore for *N* at a time is a separate primitive. |
| Named rate limiters (`RateLimiter::for('uploads', …)`) and the `throttle` middleware | The limiter itself is complete; naming limits and applying them per route is HTTP work, and lands with the middleware in `@elysian/http`. |
| Event classes (`CacheHit`, `KeyWritten`, …) | Events are dispatched as names — `cache.hit`, `cache.written`, `cache.forgotten`, `cache.flushed` — which is how the rest of the framework dispatches. A listener gets the same payload either way. |
| Automatic pruning of the `database` store | `cache:prune` exists and deletes expired rows; nothing runs it on a schedule until the scheduler lands. The other drivers expire on their own. |
| `many()` as one round trip on `file` and `array` | Both read key by key. Redis uses `MGET` and the database store one `where in`, which is where it matters. |

Two behaviours worth knowing rather than discovering:

- **Tagged entries linger.** Flushing a tag rotates its id, so every key written
  under the old namespace becomes unreachable at once — but the entries stay until
  their own TTL runs out. That is what lets tags work without an index of which
  keys belong to which tag, and it is Laravel's design too.
- **`flush()` on Redis scans this store's prefix** rather than issuing `FLUSHDB`,
  which would take another application's keys with it. With no prefix configured
  there is nothing to scan for, and it does flush the database.

## Not started

`queue`, `scheduler`, `mail`, `storage`, `notifications`.

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
- `create-elysian` — covered end to end by the smoke test rather than by units
- MySQL/Postgres **grammar** paths that the dialect suite does not reach, such as
  `insertGetId` on MariaDB
- the cache's `database` driver against Postgres and MySQL — the conformance
  suite runs it on SQLite, and the upsert and `for update` paths it relies on are
  covered for those dialects by the database package's own suite
- better-auth **plugin** schemas against real servers — the adapter itself is
  covered on SQLite, Postgres 17 and MySQL 9 by `packages/auth/test/dialects.test.ts`,
  but only for the four core tables
