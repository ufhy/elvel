# playground

An [Elysian](https://github.com/) application — Laravel's structure and DX on
Elysia + Bun.

## Getting started

```bash
bun install
cp .env.example .env
bun run dev
```

Then open <http://localhost:3000>.

## Artisan

```bash
bun run artisan                            # list commands
bun run artisan about                      # app info
bun run artisan route:list                 # registered routes
bun run artisan make:controller Post -r    # resource controller
bun run artisan make:view pages.about      # page component
bun run artisan make:component Alert       # shared component
bun run artisan make:provider Route        # service provider
bun run artisan make:command SendReports   # console command
```

## Layout

```
app/
  Console/Commands/     auto-discovered Artisan commands
  Http/Controllers/     controllers (each one is an Elysia instance)
  Providers/            service providers
bootstrap/app.ts        env -> config -> exceptions -> providers -> routes
config/                 every file's default export becomes a config namespace
resources/views/        JSX view components
public/                 static assets served by @elysiajs/static
routes/web.ts           route registration
```

## Views

Views are `@kitajs/html` components: JSX compiled straight to strings, no
virtual DOM. Layouts are components and the page body arrives as `children`.

```tsx
// resources/views/pages/about.tsx
import { Layout } from '../components/layout.tsx'

export function About({ title }: { title: string }) {
  return (
    <Layout title={title}>
      <h1 safe>{title}</h1>
    </Layout>
  )
}
```

Render it from a controller — the props are typechecked here, so a renamed prop
is a compile error rather than a blank page:

```ts
import { view } from '@elysian/view'
import { About } from '../../../resources/views/pages/about.tsx'

.get('/about', () => view(About, { title: 'About' }))
```

Controllers stay `.ts`; only files containing JSX syntax need `.tsx`. Always mark
interpolated user input with `safe` so it is HTML-escaped.

## Tests

```sh
bun test          # this application's own tests
bun test test/http.test.ts
```

`test/` is the answer to "how do I test an application built with this". Each
file presses the booted application through `@elysian/testing` rather than
starting a server, so routing, middleware, the session, validation and the
exception handler all run — the only thing skipped is the socket.

| File | What it covers |
| --- | --- |
| `http.test.ts` | pages, JSON, validation, headers, cookies, the exception handler |
| `session.test.ts` | session across requests, CSRF, flash data, the cookie's flags |
| `auth.test.ts` | `actingAs`, the guard, the Gate |
| `database.test.ts` | models, soft deletes, casts, the query builder |
| `cache.test.ts` | put/get/forget, `remember`, counters, locks |
| `mail.test.ts` | `mail().fake()` and the message assertions |
| `queue.test.ts` | `queue().fake()` — what was pushed, where, and with what delay |
| `services.test.ts` | storage, notifications, encryption, hashing, events |
| `framework.test.ts` | the schedule, translation, channels, the support helpers |
| `tooling.test.ts` | hashing, concurrency, process and image, over HTTP |
| `console.test.ts` | artisan commands, their output and their exit codes |

Two things are deliberately **not** here. The HTTP client's retry, timeout and
connection-failure paths need a real socket, so they are exercised by
`bun run smoke` against a listening server. And the auth kit's pages live in
`packages/create-elysian/kits/auth`, so they are proved by the same smoke run
against a freshly scaffolded application.
