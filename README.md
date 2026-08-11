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
bun run artisan make:provider Route
bun run artisan make:command SendReports
```

## Packages

| Package | Contents |
| --- | --- |
| `@elysian/contracts` | Interfaces only. Breaks dependency cycles between packages. |
| `@elysian/support` | `Str`, `Arr`, `Collection`, `Macroable`, `Conditionable`. |
| `@elysian/core` | `Application`, `ServiceProvider`, `Config`, `Env`, exception handler, `controller()`, helpers. |
| `@elysian/console` | Artisan: signature parser, command base, kernel, stub generators. |
| `@elysian/view` | Edge.js view factory, `view()` helper, static file serving. |
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

**Views are Edge.js, not a Blade compiler.** Edge is the closest thing Node has
to Blade and is maintained standalone by the AdonisJS team. Note Edge 6 has no
`@layout`/`@section`/`@extends` — layouts are components with slots, and its
compile cache is in-memory only (there is no `storage/framework/views`).

**Workspace linking, never `file:` dependencies.** Bun hardlinks `file:`
dependencies into its store; an editor that writes by replacing a file detaches
the copy, and the app then runs stale code while TypeScript sees two identities
of the same module. Apps scaffolded inside this repo become workspace members.

## Bootstrap order

Fixed, and it mirrors `Illuminate\Foundation\Http\Kernel`:

```
env -> config -> exceptions -> register providers -> boot providers -> routes
```

Framework providers come from `config/app.ts`; application providers are passed
to `Application.configure().withProviders()` so they register last and can
override framework bindings.

## Development

```bash
bun run verify   # lint -> typecheck -> test -> smoke. Run this on every change.
```

Individually:

```bash
bun run lint
bun run typecheck
bun run test     # 44 unit + integration tests
bun run smoke    # 52 checks against the real playground app
```

### playground/

`playground/` is a tracked workspace member — the same skeleton `bun run create`
produces, plus an `ExerciseController`, an `exercise.edge` view, and a `Ping`
command that exist purely to give the smoke test something real to assert
against.

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

`bun test --coverage` currently reports ~51% of functions. The gaps are known and
tracked: `Collection`, `Macroable`, `parseEnvFile`, and the generators have no
unit tests — the generators and the scaffolder are covered by the smoke test
instead, which catches behaviour but not edge cases.

## Roadmap

Milestone 1 is done. Next, in dependency order:

1. `events` + `log`
2. `database` — connections, query builder, and a migrator with `up()`/`down()`.
   Drizzle executes the SQL; `drizzle-kit` is not the migrator, because it is
   forward-only and has no rollback.
3. `database` — Eloquent: models, casts, scopes, relations, eager loading.
   Note lazy loading cannot be synchronous on Bun: `await user.posts()`.
4. `validation` — two phases. TypeBox handles shape/type/format synchronously
   (it has no async path and no `refine`); a RuleRunner of ours handles
   `unique`/`exists` and the ~24 cross-field rules.
5. `http` — `FormRequest`, `JsonResource`, session, cookies, CSRF
6. `auth` — better-auth adapter (`mount(auth.handler)` + macro) plus Gate/Policy
7. `cache`, `queue`, `scheduler`, `mail`, `storage`
