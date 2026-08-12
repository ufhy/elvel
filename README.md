# Elysian

Laravel's structure and developer experience, built on [Elysia](https://elysiajs.com)
and Bun.

**Status: application core, CLI, views, events, logging and the database layer
(query builder, models, migrations) are built.** Validation, HTTP form requests
and auth are not — see the roadmap.

## Quick start

```bash
bun install
bun run create apps/blog   # scaffold
bun install                # link the new workspace member
cd apps/blog && bun run dev
```

`bun create elysian my-app` does **not** work yet. `bun create <name>` resolves
only via `bunx create-<name>` on npm, a GitHub repo, or a template folder in
`$HOME/.bun-create` / `./.bun-create` — never a workspace package. The short
form starts working once `create-elysian` is published.

Open <http://localhost:3000>.

```bash
bun run artisan                            # list commands
bun run artisan about
bun run artisan route:list
bun run artisan make:controller Post -r
bun run artisan make:view pages.about
bun run artisan make:component Alert
bun run artisan make:provider Route
bun run artisan make:command SendReports
bun run artisan migrate
bun run artisan migrate:rollback --step=2
bun run artisan migrate:status
bun run artisan make:migration create_posts_table
bun run artisan make:model Post -mfs        # model + migration + factory + seeder
bun run artisan db:seed
bun run artisan db:show
bun run artisan db:table users
bun run artisan make:event OrderShipped
bun run artisan make:listener RecordShipments --event OrderShipped
```

## Packages

| Package | Contents |
| --- | --- |
| `@elysian/contracts` | Interfaces only. Breaks dependency cycles between packages. |
| `@elysian/support` | `Str`, `Arr`, `Collection`, `Macroable`, `Conditionable`. |
| `@elysian/core` | `Application`, `ServiceProvider`, `Config`, `Env`, exception handler, `controller()`, helpers. |
| `@elysian/database` | Connections, query builder, models, schema builder and migrator on Bun.SQL. |
| `@elysian/events` | Dispatcher with wildcards, halting, subscribers, `EventFake`. |
| `@elysian/log` | Channels and drivers (console, json, single, daily, stack, null). |
| `@elysian/console` | Artisan: signature parser, command base, kernel, stub generators. |
| `@elysian/view` | JSX renderer (`@kitajs/html`), `view()`/`render()` helpers, static file serving. |
| `create-elysian` | Application skeleton scaffolder. |

## Design decisions

**The container is typed, not stringly-typed.** Laravel leans on
`app('cache')` + facades; copying that verbatim would destroy Elysia's
end-to-end inference, its main advantage. Bindings are declared by augmenting
`ContainerBindings`, so `app('view')` resolves to a real type. That interface
must stay an `interface` — a type alias cannot be augmented.

**Controllers are Elysia instances, not classes of static handlers.** This is
what Elysia's own docs prescribe, and the only shape that keeps the request
context inferred inside handlers. Each controller carries a `name` so Elysia
deduplicates its routes.

**Global helpers instead of context decorators.** `view()`, `config()`, `app()`
resolve from the running application, like Laravel's helpers. Decorating the
Elysia context instead would force every route to carry those types.

**Views are typed JSX, not a template language.** `@kitajs/html` compiles JSX
straight to strings — no virtual DOM, ~2-3x faster than React/Preact/Hono JSX at
about half the memory. A view is a function, so `tsc` is the template checker and
Bun's module cache is the compile cache: no view paths, no compiled-view
directory, and a renamed prop is a compile error instead of a blank page.

Components are passed by reference, never by name:

```ts
// app/Http/Controllers/PageController.ts  — stays .ts, no JSX syntax here
import { view } from '@elysian/view'
import { Landing } from '../../../resources/views/pages/landing.tsx'

.get('/', () => view(Landing, { title: 'Welcome' }))
```

Only files containing JSX syntax need `.tsx`; a `.ts` file with a JSX literal is
a syntax error in both `tsc` and Bun. Layouts are components and the page body
arrives as `children` (typed as `Children` from `@kitajs/html`). `view()`
prepends `<!DOCTYPE html>` when the markup opens with `<html`, since JSX has no
doctype node.

**Escaping is opt-in.** Mark interpolated user input with `safe` —
`<span safe>{comment}</span>` — and it is HTML-escaped at render time. The
matching compile-time checker, `@kitajs/ts-html-plugin`, **cannot be wired into
`bun run verify` today**: its CLI reads `typescript.sys`, which TypeScript 7
removed from the default export, so it crashes under both Bun and Node. Until
that is fixed, `safe` is a runtime guarantee and a review responsibility.

**Workspace linking, never `file:` dependencies.** Bun hardlinks `file:`
dependencies into its store; an editor that writes by replacing a file detaches
the copy, and the app then runs stale code while TypeScript sees two identities
of the same module. Apps scaffolded inside this repo become workspace members.

## Events and logging

Both follow `Illuminate\Events\Dispatcher` and `Illuminate\Log\LogManager`
semantics, read from the source rather than guessed:

```ts
// A class event is its own payload, and its listener's argument is typed.
class OrderShipped {
  static readonly eventName = 'order.shipped'   // survives class renaming
  constructor(readonly orderId: number) {}
}

events().listen(OrderShipped, (event) => event.orderId)   // typed
events().listen('order.*', (name, payload) => {})         // wildcard
await dispatch(new OrderShipped(42))
```

- a listener returning `false` stops propagation; `until()` returns the first
  non-null response and skips the rest
- wildcard matches are cached per event name and invalidated when a new pattern
  is registered
- `push()`/`flush()` defer through a synthetic `<event>_pushed` event
- classes in `app/Listeners` with a `subscribe` method are discovered
  automatically; `EventFake` records dispatches for tests and `NullDispatcher`
  swallows them while keeping registration observable

Queued listeners are **absent on purpose** until the queue package exists —
there is no fallback that runs them synchronously and calls it queued.

```ts
log().info('User {id} signed in', { id: 7 })    // {placeholders} interpolate
log().channel('daily').warning('Disk filling')
log().shareContext({ request_id: id })          // sticks to every channel
log().extend('pino', (config) => new PinoDriver(config))
```

Channels pair a driver with a minimum level, using the same eight RFC 5424
levels and Monolog's severity numbers, so a `level` behaves as it does in
Laravel. A typo in a level or a stack that includes itself fails at boot rather
than at 3am. Logging is fire-and-forget: `log().info()` never awaits its driver,
so a file write cannot slow a request.

`config/logging.ts` also carries an opt-in access log (`LOG_REQUESTS=true`) that
attaches a request id and reports method, path, status and duration.

## Database

No ORM dependency. Bun 1.3 ships native SQL for **sqlite, postgres, mysql and
mariadb**, with pooling, transactions and savepoints, so the data layer has no
third-party driver at all. Drizzle was evaluated and dropped: since the query
builder, schema builder and migrator are ours, its remaining value was a schema
DSL that would duplicate migrations as a second source of truth — and
`drizzle-kit` is forward-only, with no rollback.

`Bun.SQL` sits behind a `Connection` interface, so a Node driver (`pg`,
`mysql2`, `node:sqlite`) would be an added file rather than a rewrite.

```ts
const users = await db().table('users')

await users.where('votes', '>', 10).orderByDesc('votes').limit(5).get()
await users.upsert({ email: 'ada@example.com', votes: 1 }, ['email'])
await connection.transaction(async (tx) => { /* rolled back on throw */ })
```

Dialect differences are handled rather than assumed away, and the details come
from Laravel's source:

- **placeholders** — PDO normalises them and Bun.SQL does not, so `parameter()`
  is per-dialect: postgres emits `$1..$n`, the others `?`
- **upsert** — `on conflict (…) do update` for postgres/sqlite, `on duplicate
  key update` for mysql, which has no conflict target
- **auto-increment** — sqlite collapses every integer width to `integer` and
  inlines `primary key autoincrement`; postgres uses `bigserial`; mysql appends
  `auto_increment primary key`
- **modifier order** — verbatim per grammar, because SQL rejects the wrong one:
  sqlite puts `increment` first, mysql puts `unsigned` first and position last
- **truncate** — sqlite deletes rows and resets `sqlite_sequence`, postgres
  restarts identity, mysql truncates

An empty `whereIn` compiles to `0 = 1` rather than invalid SQL, and where
operators are validated against a known list instead of interpolated.

### Models

The model layer has no brand name — it is `Model`, and the docs call them models.
Laravel needs "Eloquent" because its ecosystem has a marketing surface; a
descriptive name costs nothing to explain.

```ts
class User extends Model {
  static override table = 'users'
  static override fillable = ['name', 'email']
  static override casts = { active: 'boolean', meta: 'json' }

  declare id: number
  declare name: string

  posts() { return this.hasMany(Post) }
}

const user = await User.create({ name: 'Ada' })
await User.where('votes', '>', 10).orderByDesc('votes').paginate(1, 15)
```

Attribute access goes through a Proxy, so `user.name` reads an attribute while
`user.save()` stays a method; `declare` gives the columns types without
shadowing it at runtime. Casts matter more here than in PHP — SQLite has no
boolean, so `active` arrives as `0`, and `'0'` is truthy in JavaScript.

**Relations are methods, and there is no synchronous lazy loading.** Reaching the
database is asynchronous on Bun, so `user.posts` cannot return rows the way
`$user->posts` does; it is `await user.posts().get()`. `with()` is what keeps
that from becoming an N+1 — it uses the two-query strategy from Laravel's
`addEagerConstraints`/`match`: collect the parents' keys, fetch every child in
one `where in`, build a dictionary, assign. Parents with a null key are skipped
rather than matched against null. `hasMany`, `hasOne`, `belongsTo` and
`belongsToMany` are covered, including `attach`/`detach`/`sync` and nested
`with('posts.comments')`.

Saving follows `performUpdate`: only dirty columns are sent, and a clean model
issues **no query at all**. Dirty comparison tolerates driver type drift, so a
column that comes back as `5` and is reassigned `'5'` is not reported as changed.

Also present: global scopes (`addGlobalScope` / `withoutGlobalScope`),
`whereHas`/`has`/`doesntHave` as correlated `exists` subqueries so the parent
rows are never multiplied, `withCount`/`withSum`/`withMax` as select subqueries,
accessors and mutators (`getFullNameAttribute`), `appends`, `getChanges` /
`wasChanged`, `replicate`, `is`/`isNot`, `only`/`except`, `withoutTimestamps`,
`sole`, `firstWhere`, `lazy()`, morph relations (`morphTo`/`morphOne`/`morphMany`),
`hasManyThrough`, and the full pivot surface (`attach`/`detach`/`sync`/
`syncWithoutDetaching`/`toggle`/`updateExistingPivot`).

`morphTo` eager loading issues one query per distinct type, which is the floor
rather than a shortcoming: the rows point at different tables. Asking `whereHas`
of a `morphTo` throws with an explanation instead of guessing a table.

### Factories and seeders

```ts
class UserFactory extends Factory<User> {
  readonly model = User

  definition(index: number) {
    return { name: `User ${index}`, email: `user${index}@example.com` }
  }
}

await new UserFactory().count(3).state({ active: false }).create()
```

No fake-data generator is bundled. `definition()` receives a 0-based index, so
unique values are derived from it rather than from a random source that collides
with a unique index roughly one run in fifty. Factories bypass `fillable`, as
Laravel's do.

Seeders are composed explicitly with `call()` — there is no auto-discovery,
because seed order matters and a directory listing is a poor way to express it. A
seeder pulled in by two others still runs once.

### Testing against real servers

`packages/database/test/dialects.test.ts` runs the same assertions against
SQLite, Postgres and MySQL. Every other test in the package asserts the SQL we
generate; this one proves a server accepts it, which is a different claim.

```bash
# defaults to 127.0.0.1:5432 (postgres) and 127.0.0.1:3309 (mysql)
TEST_POSTGRES_URL=postgres://user:pass@host:5432/db bun test dialects
```

A dialect whose server is unreachable is skipped with a note rather than
failing, so the suite stays green without them — but then it is only proving
SQLite. It creates its own `elysian_test` database per server: MySQL's system
schema `mysql` does **not** enforce InnoDB foreign keys, so running there
silently accepted rows a real application database rejects.

Three bugs it caught that no amount of SQL-string assertion would have:

- the schema grammar's introspection queries hardcoded `?`, so `hasTable` and
  `getColumnListing` were unparseable on Postgres — placeholders leak beyond
  the query grammar
- `default true` on a boolean column compiled to `default 1`, which Postgres
  rejects as a type error
- the boolean cast wrote `1`/`0`, which Postgres also rejects; it now writes a
  real boolean, which every dialect accepts

Known and deliberate: MySQL refuses to `truncate` a table a foreign key points
at, however empty the child is. The grammar does not disable foreign key checks
behind your back, so `delete()` is the way to empty such a table.

### Migrations

```ts
export default class extends Migration {
  async up({ schema }: MigrationContext) {
    await schema.create('posts', (table) => {
      table.id()
      table.foreignId('user_id').constrained().cascadeOnDelete()
      table.string('title')
      table.timestamps()
    })
  }

  async down({ schema }: MigrationContext) {
    await schema.dropIfExists('posts')
  }
}
```

`down()` is required, which is the whole reason `drizzle-kit` was not used. The
tracking table matches Laravel's (`id`, `migration`, `batch`), `migrate` records
one batch per run (`--step` gives each migration its own), and
`migrate:rollback` reverses the newest batch newest-first. On sqlite and postgres
each migration runs in a transaction, so a failure halfway leaves no table
behind; mysql implicitly commits DDL, so wrapping there is skipped rather than
faked.

## Bootstrap order

Fixed, and it mirrors `Illuminate\Foundation\Http\Kernel`:

```
env -> config -> exceptions -> register providers -> boot providers -> routes
```

Framework providers come from `config/app.ts`; application providers are passed
to `Application.configure().withProviders()` so they register last and can
override framework bindings. Events and logging are registered first, as
Laravel's base providers are, because everything booting after them may emit
events or write logs.

## Development

```bash
bun run verify   # lint -> typecheck -> test -> smoke. Run this on every change.
```

Individually:

```bash
bun run lint
bun run typecheck
bun run test     # 582 tests, including 64 against real Postgres and MySQL
bun run smoke    # 81 checks against the real playground app
```

### playground/

`playground/` is a tracked workspace member — the same skeleton `bun run create`
produces, plus an `ExerciseController`, an `exercise.tsx` view (with an async
component and a deliberately unsafe-looking prop), and a `Ping` command that
exist purely to give the smoke test something real to assert against.

```bash
bun run playground:dev              # serve it with --watch
bun run playground route:list       # any Artisan command
bun run playground:reset --force    # regenerate from the template (destructive)
```

Because the framework packages are linked by symlink, editing `packages/*` takes
effect in the playground immediately — which is the point: `bun run smoke` boots
this app, renders its views, runs its commands, generates code into it (then
cleans up), scaffolds a throwaway project, and binds a real socket. A broken
template or stub fails there even when every unit test still passes.

`tests/fixture` is a separate, minimal application used by the automated
integration tests; the playground is for end-to-end checks and manual poking.

### Test coverage

`bun test --coverage` reports **74% of functions / 85% of lines**. Every package
has unit tests except `contracts` (interfaces only, no runtime) and
`create-elysian` (covered end to end by the smoke test).

Deliberately not unit-tested:

- `output.ts` and `about.ts` — terminal formatting; the smoke test asserts the
  text that matters, and pinning colour codes would test `picocolors`.
- `serve.ts` — its `handle()` never resolves by design; the smoke test binds a
  real socket instead.
- `command.ts` accessors — exercised through the kernel and generator tests
  rather than in isolation.
- `str.ts` inflection edge cases beyond the common forms.

## Known gaps

[`GAPS.md`](GAPS.md) records what is deliberately missing in every finished
package, and why — including one thing that was attempted and could not be made
to work (compile-time XSS checking, blocked by a TypeScript 7 incompatibility in
`@kitajs/ts-html-plugin`).

## Roadmap

Milestone 1, events + log, and the database layer are done — connections, query
builder, models with relations and eager loading, schema builder, migrator,
factories and seeders, verified against SQLite, Postgres and MySQL. Next, in
dependency order:

1. `validation` — two phases. TypeBox handles shape/type/format synchronously
   (it has no async path and no `refine`); a RuleRunner of ours handles
   `unique`/`exists` and the ~24 cross-field rules.
2. `http` — `FormRequest`, `JsonResource`, session, cookies, CSRF
3. `auth` — better-auth through `createAdapterFactory` over our own query
   builder, so its `createSchema` emits our migration format rather than a
   second schema; plus Gate/Policy
4. `cache`, `queue`, `scheduler`, `mail`, `storage`
