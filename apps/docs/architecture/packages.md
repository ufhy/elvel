# The 27 packages

Laravel is one package. Elvel is twenty-seven, and this page is why.

| Package | Contents |
| --- | --- |
| `@elvel/contracts` | Interfaces only. Breaks dependency cycles between packages. |
| `@elvel/support` | `Str`, `Arr`, `Collection`, `Macroable`, `Conditionable`. |
| `@elvel/core` | `Application`, `ServiceProvider`, `Config`, `Env`, exception handler, `controller()`, helpers. |
| `@elvel/database` | Connections, query builder, models, schema builder and migrator on Bun.SQL. |
| `@elvel/http` | `FormRequest`, `JsonResource`, sessions, signed and encrypted cookies, CSRF, rate limiting, CORS, trusted proxies. |
| `@elvel/validation` | Two-phase validation: ~50 rules, `unique`/`exists`, error bags. |
| `@elvel/events` | Dispatcher with wildcards, halting, subscribers, `EventFake`. |
| `@elvel/log` | Channels and drivers (console, json, single, daily, stack, null). |
| `@elvel/console` | The CLI: signature parser, command base, kernel, stub generators. |
| `@elvel/view` | JSX renderer (`@kitajs/html`), `view()`/`render()` helpers, static file serving. |
| `@elvel/auth` | better-auth over our own query builder, plus Gate and policies. |
| `@elvel/cache` | Four stores (array, file, database, redis) with atomic locks, tags and a rate limiter. |
| `@elvel/queue` | Jobs, three drivers, worker with Laravel's retry policy, chains, failed jobs. |
| `@elvel/scheduler` | Cron matcher, `withoutOverlapping`, timezones, `schedule:run`/`schedule:test`. |
| `@elvel/mail` | Mailables, nodemailer transports, queued mail. |
| `@elvel/storage` | Disks (`local`, `s3` on Bun.S3Client), path guard, offline presigned URLs. |
| `@elvel/notifications` | Channels (mail, database, log), per-recipient ids, on-demand recipients. |
| `@elvel/encryption` | AES-256-GCM, HKDF-derived keys, context binding, key rotation, `key:generate`. |
| `create-elvel` | Application skeleton scaffolder. |

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
import { view } from '@elvel/view'
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
