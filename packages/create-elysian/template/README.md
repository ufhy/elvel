# {{ name }}

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
bun run artisan make:model Post -mfs       # model + migration + factory + seeder
bun run artisan migrate                    # run migrations
bun run artisan db:seed                    # run DatabaseSeeder
bun run artisan db:show                    # tables and row counts
```

## Putting data on a page

The landing page needs no database — this application boots and serves without
one, and `config/database.ts` is only consulted the first time something asks.
When you do want rows, the path is four commands and two edits:

```bash
bun run artisan make:model Post -mfs   # model, migration, factory, seeder
```

Add the columns to `database/migrations/*_create_posts_table.ts`:

```ts
await schema.create('posts', (table) => {
  table.id()
  table.string('title')
  table.text('body')
  table.timestamps()
})
```

…and the same names to `database/factories/PostFactory.ts`, which starts empty
so it cannot name a column the migration has not created:

```ts
definition(index: number) {
  return { title: `Post ${index}`, body: 'Something to read.' }
}
```

Then create the table and fill it — `db:seed` runs `DatabaseSeeder`, which is
where `PostSeeder` gets called from:

```bash
bun run artisan migrate
bun run artisan db:seed
```

Read them in a controller, and hand them to the page:

```ts
import { Post } from '../../Models/Post.ts'

export default controller('page').get('/', async () =>
  view(Landing, { title: 'Welcome', posts: await Post.query().latest().get() })
)
```

A page is a function of its props, so `posts` is typed all the way into the
markup — a renamed column is a compile error rather than a blank section.

## Layout

```
app/
  Console/Commands/     auto-discovered Artisan commands
  Http/Controllers/     controllers (each one is an Elysia instance)
  Providers/            service providers
bootstrap/app.ts        env -> config -> exceptions -> providers -> routes
config/                 every file's default export becomes a config namespace
app/Models/             models
database/migrations/    migrations, ordered by their timestamp prefix
database/seeders/       seeders, composed explicitly
database/factories/     model factories
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
