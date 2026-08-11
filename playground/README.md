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
bun run artisan make:view pages.about      # Edge view
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
resources/views/        Edge templates
public/                 static assets served by @elysiajs/static
routes/web.ts           route registration
```

## Views

Edge 6 has no `@layout`/`@section`. Layouts are components; the page body
arrives in the default `main` slot:

```edge
@component('components/layout', { title: 'About' })
  <h1>About</h1>
@endcomponent
```
