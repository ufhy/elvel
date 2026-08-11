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
