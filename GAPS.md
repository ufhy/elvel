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

## Not started

`validation`, `http` (FormRequest, JsonResource, session, cookies, CSRF), `auth`
(better-auth via `createAdapterFactory`), `cache`, `queue`, `scheduler`, `mail`,
`storage`, `notifications`.

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
