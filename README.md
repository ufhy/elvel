# Elysian

Laravel's structure and developer experience, built on [Elysia](https://elysiajs.com)
and Bun.

**Status: milestone 1 (walking skeleton).** Scaffold an app, generate code with an
Artisan-style CLI, and serve server-rendered pages. Database, Eloquent,
validation, and auth are not built yet — see the roadmap.

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
bun run artisan make:event OrderShipped
bun run artisan make:listener RecordShipments --event OrderShipped
```

## Packages

| Package | Contents |
| --- | --- |
| `@elysian/contracts` | Interfaces only. Breaks dependency cycles between packages. |
| `@elysian/support` | `Str`, `Arr`, `Collection`, `Macroable`, `Conditionable`. |
| `@elysian/core` | `Application`, `ServiceProvider`, `Config`, `Env`, exception handler, `controller()`, helpers. |
| `@elysian/database` | Connections, query builder, schema builder and migrator on Bun.SQL. |
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
bun run test     # 415 unit + integration tests
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

`bun test --coverage` reports **74% of functions / 86% of lines**. Every package
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

## Roadmap

Milestone 1, events + log, and the database layer (connections, query builder,
schema builder, migrator) are done. Next, in dependency order:

1. `database` — Eloquent: models, casts, scopes, relations, eager loading.
   Note lazy loading cannot be synchronous on Bun: `await user.posts()`.
2. `validation` — two phases. TypeBox handles shape/type/format synchronously
   (it has no async path and no `refine`); a RuleRunner of ours handles
   `unique`/`exists` and the ~24 cross-field rules.
3. `http` — `FormRequest`, `JsonResource`, session, cookies, CSRF
4. `auth` — better-auth through `createAdapterFactory` over our own query
   builder, so its `createSchema` emits our migration format rather than a
   second schema; plus Gate/Policy
5. `cache`, `queue`, `scheduler`, `mail`, `storage`
