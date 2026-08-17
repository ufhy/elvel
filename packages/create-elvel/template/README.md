# {{ name }}

An [Elvel](https://github.com/) application — Laravel's structure and DX on
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
bun run artisan make:model Post -mfs       # model + migration + factory + seeder
bun run artisan migrate                    # run migrations
bun run artisan db:seed                    # run DatabaseSeeder
bun run artisan db:show                    # tables and row counts
```

## Adding a database

This application has none. It boots, serves, and renders without one, and
nothing in it opens a connection — which is why `@elvel/database` is not
installed and there is no `database/` directory.

Three steps to change that:

```bash
bun add @elvel/database
bun artisan config:publish database
```

then add `DatabaseServiceProvider` to `bootstrap/providers.ts`, importing it
from `@elvel/database`. That registers `make:model`, `migrate`, `db:seed` and
the rest.

From there:

```bash
bun artisan make:model Post -mfs
```

which writes a model, a migration, a factory and a seeder. The migration starts
with `id` and timestamps — add your columns there, and the matching lines to the
factory's `definition()`, which starts empty for that reason. Then:

```bash
bun artisan migrate
bun artisan db:seed
```

And on a page:

```ts
import { controller } from '@elvel/core'
import { view } from '@elvel/view'
import { Post } from '../../Models/Post.ts'
import Landing from '../../../resources/views/pages/landing.tsx'

export default controller('page').get('/', async () =>
  view(Landing, { title: 'Welcome', posts: await Post.query().latest().get() })
)
```

## Layout

```
app/
  Console/Commands/     auto-discovered Artisan commands
  Http/Controllers/     controllers (each one is an Elysia instance)
  Providers/            service providers
bootstrap/app.ts        env -> config -> exceptions -> providers -> routes
bootstrap/providers.ts  the providers this application registers
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
import { view } from '@elvel/view'
import { About } from '../../../resources/views/pages/about.tsx'

.get('/about', () => view(About, { title: 'About' }))
```

Controllers stay `.ts`; only files containing JSX syntax need `.tsx`. Always mark
interpolated user input with `safe` so it is HTML-escaped.
