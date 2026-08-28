# {{ name }}

An [Elvel](https://github.com/ufhy/elvel) application — Laravel's structure and
developer experience on Elysia and Bun.

## Getting started

The scaffolder has already installed the dependencies, written an `.env` with its
own generated secrets, and run the migrations. So:

```bash
bun run dev
```

Then open <http://localhost:3000>.

That one command runs the server, the Vite dev server, and — if this application
has them — a queue worker and the scheduler. Edit a `.tsx` view and the browser
reloads itself: the server re-evaluates the changed module under `bun --hot`, and
a plugin in `vite.config.ts` pushes a reload down the socket Vite already holds.
Neither Bun nor Elysia can do that second half, which is why it lives there.

## Commands

```bash
bun run elvel                            # list every command this app has
bun run elvel about                      # what is configured, and where
bun run elvel route:list                 # registered routes, with middleware
bun run elvel make:controller Post -r    # resource controller
bun run elvel make:view pages.about      # page component
bun run elvel make:component Alert       # shared component
bun run elvel make:command SendReports   # console command
bun run elvel make:rule Uppercase        # validation rule
bun run elvel make:provider Route        # service provider
```

**A command exists only if its package is registered.** `bun run elvel` lists what
this application actually has, which is not the same as what the framework
offers — `bootstrap/providers.ts` decides. Adding a package adds its commands.

## Routing and controllers

Routes are declared in `routes/web.ts`, and the file exports nothing — the same
shape as Laravel's `routes/web.php`.

```ts
// routes/web.ts
import { Route } from '@elvel/http'
import { view } from '@elvel/view'
import { Welcome } from '../resources/views/pages/welcome.tsx'

Route.get('/', () => view(Welcome, { title: 'Welcome' })).name('home')
Route.get('/health', () => ({ status: 'ok' }))
```

A handler is either a closure or `[Controller, 'method']` — Laravel's `fn () => …`
and `[Controller::class, 'method']`. The two above are closures because neither has
anything a class would hold.

```ts
// app/Http/Controllers/UserController.ts
import { view } from '@elvel/view'
import { Users } from '../../../resources/views/pages/users.tsx'

export default class UserController {
  show({ params }: { params: { id: string } }) {
    return view(Users, { id: params.id })
  }
}
```

```ts
Route.get('/users/{id}', [UserController, 'show']).whereNumber('id')
```

A controller is a plain class, and it earns its keep when several related actions
belong together or there is logic worth testing on its own. Each method receives
Elysia's request context, so `{ params, query, body, request, set }` is
destructured from its argument — a closure takes the same thing as its argument.
One instance is built per route and reused — keep them stateless.

Groups, names, constraints and resources all read the way they do in Laravel:

```ts
Route.middleware('auth').prefix('admin').name('admin.').group(() => {
  Route.resource('photos', PhotoController)
})

Route.get('/users/{id}', [UserController, 'show']).name('users.show').whereNumber('id')
Route.view('/{path}', MainLayout, { title: 'App' }).where('path', '.*')
Route.fallback(() => view(NotFound, {}))
```

`bun run elvel route:list` prints the table. Controllers stay `.ts`; only files
that contain JSX syntax need `.tsx`.

## Views

Views are `@kitajs/html` components: JSX compiled straight to strings, no virtual
DOM. Layouts are components and the page body arrives as `children`.

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

Always mark interpolated user input with `safe` so it is HTML-escaped.

## Validation

`validate()` takes the payload and the rules, returns the checked data, and
throws otherwise. The exception handler turns that into a 422 carrying a message
per field, so a handler does not have to catch anything:

```ts
import { validate } from '@elvel/validation'

.post('/api/signup', async ({ body }) => ({
  user: await validate(body as Record<string, unknown>, {
    email: 'required|email',
    age: 'required|integer|min:18'
  })
}))
```

```
200  {"user":{"email":"a@b.co","age":"21"}}
422  {"message":"The email field must be a valid email address.",
      "errors":{"email":[…],"age":[…]}}
```

For a browser form the errors come back through the session instead — `errors()`
reads them in the view, and the old input is repopulated.

## Middleware

Named rather than discovered, and attached per route or per group:

```ts
import { middleware } from '@elvel/http'

.post('/api/signup', handler, middleware('throttle:6,1'))
```

`bun run elvel middleware:list` shows every name this application has registered.

## CSRF

Any state-changing request that is not exempt needs a token, which is why the
example above sits under `/api`. `config/session.ts` carries the exemptions:

```ts
csrfExcept: ['/api/*']
```

A form gets its token from `csrfField()`; a POST without one answers **419**, not
a silent failure.

## Tests

```bash
bun test
```

`tests/Feature` boots the application, `tests/Unit` does not — Laravel's split,
kept because the two have very different costs.

```ts
import { test as press } from '@elvel/testing'
import app from '../../bootstrap/app.ts'

const response = await press(app).get('/')

response.assertOk().assertSee('<!DOCTYPE html>')
```

`press(app)` runs the request through the same `handle()` a server would —
middleware, session, validation, the exception handler and all — so what passes
here is what a browser would have got. No socket, no port to pick.

## Adding a database

This application has none: nothing in it opens a connection, which is why
`@elvel/database` is not installed and there is no `database/` directory.

Three steps to change that:

```bash
bun add @elvel/database
bun run elvel config:publish database
```

then add `DatabaseServiceProvider` to `bootstrap/providers.ts`, importing it from
`@elvel/database`. That registers `make:model`, `migrate`, `db:seed` and the rest.

From there:

```bash
bun run elvel make:model Post -mfs
```

which writes a model, a migration, a factory and a seeder. The migration starts
with `id` and timestamps — add your columns there, and the matching lines to the
factory's `definition()`, which starts empty for that reason. Then:

```bash
bun run elvel migrate
bun run elvel db:seed
```

And on a page:

```ts
// routes/web.ts
Route.get('/', async () =>
  view(Welcome, { title: 'Welcome', posts: await Post.query().latest().get() })
)
```

Anything else a package offers arrives the same way: `bun add @elvel/mail`,
`config:publish mail`, then its provider.

## Building for production

Bun re-transpiles every module in every process, which costs seconds on every
boot. A bundle removes it:

```bash
bun run elvel optimize      # cache the config, then build
bun run start               # bun dist/elvel.js serve
```

`elvel.ts` hands over to `dist/elvel.js` on its own whenever that bundle is newer
than every source file, so commands get faster after a build and fall back to
source the moment anything changes. `elvel optimize:clear` undoes it.

## Layout

```
app/
  Http/Controllers/     controllers (each one is an Elysia instance)
  Providers/            service providers
  Console/Commands/     auto-discovered commands — `make:command` creates it
bootstrap/app.ts        env -> config -> exceptions -> providers -> routes
bootstrap/providers.ts  the providers this application registers
config/                 every file's default export becomes a config namespace
resources/views/        JSX view components
resources/css, js/      assets, built by Vite
routes/web.ts           route registration
routes/console.ts       scheduled work
public/                 static assets served by @elysiajs/static
storage/                logs, caches, sessions, compiled views
tests/Feature, Unit/    what `bun test` runs
```

`bootstrap/app.ts` names every config file so a bundler can follow them, which is
why `config:publish` adds a line there as well as copying the file.

## Where to look next

The framework's own documentation lives at
<https://github.com/ufhy/elvel>. `BEHAVIOURS.md` there records the decisions
behind each package — where it stops, and why — which is usually the answer when
something behaves differently from Laravel.
