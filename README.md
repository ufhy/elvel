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
```

## Packages

| Package | Contents |
| --- | --- |
| `@elysian/contracts` | Interfaces only. Breaks dependency cycles between packages. |
| `@elysian/support` | `Str`, `Arr`, `Collection`, `Macroable`, `Conditionable`. |
| `@elysian/core` | `Application`, `ServiceProvider`, `Config`, `Env`, exception handler, `controller()`, helpers. |
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
bun run test     # 195 unit + integration tests
bun run smoke    # 58 checks against the real playground app
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

`bun test --coverage` reports **81% of functions / 92% of lines**. Every package
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
