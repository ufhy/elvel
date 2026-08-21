# Routing

A controller **is** an Elysia instance. There is no route file mapping strings to
class methods, because that mapping is what loses the types.

```ts
// app/Http/Controllers/ArticleController.ts
import { controller } from '@elvel/core'

export default controller('article')
  .get('/articles', () => Article.all())
  .get('/articles/:id', ({ params }) => Article.findOrFail(params.id))
  .post('/articles', ({ body }) => Article.create(body))
```

```ts
// routes/web.ts
import { Elysia } from 'elysia'
import ArticleController from '../app/Http/Controllers/ArticleController.ts'

export default new Elysia({ name: 'routes:web' }).use(ArticleController)
```

`params.id` is typed from the path, and `body` from the schema when there is one.
That inference is the whole reason for this shape — a handler reached through a
string name cannot have it.

The `name` matters: Elysia deduplicates plugins by it, so a controller mounted
twice registers its routes once.

```bash
bun elvel make:controller ArticleController
bun elvel make:controller ArticleController -r   # with CRUD routes
bun elvel route:list                              # what actually got registered
```

## Grouping

```ts
import { controller, routeGroup } from '@elvel/core'

// A prefix on the whole controller
export default controller('admin', '/admin')
  .get('/users', handler)      // → /admin/users

// A group inside one file, when a handful of routes share something
export default controller('article')
  .use(routeGroup('/articles').use(publicRoutes))
  .use(routeGroup('/articles').use(middleware('auth')).use(editorRoutes))
```

`controller()` creates a **named, deduplicated** unit; `routeGroup()` does not,
which is what you want for a group that exists only inside its own file.

## Named routes

A name is declared beside the routes it belongs to:

```ts
routes().names({ login: '/sign-in' })

export default controller('auth-sign-in').get('/sign-in', handler)
```

Then build URLs from the name instead of repeating the path:

```ts
route('article', { id: 42 })      // '/articles/42'
routes().path('login')            // '/sign-in'
routes().has('login')             // true
routes().all()                    // { register: '/sign-up', login: '/sign-in', … }
```

Run against a registry holding `/articles/:id` and `/articles/:id/edit/:tab?`:

```
to('article', { id: 42 })                → /articles/42
to('edit', { id: 42, tab: 'meta' })      → /articles/42/edit/meta
to('edit', { id: 42 })                   → /articles/42/edit      (optional vanishes)
to('article', { id: 42, page: 2 })       → /articles/42?page=2    (extras become query)
```

Two mistakes are refused rather than guessed at:

```
to('article', {})   → Route [article] needs a [id] parameter.
to('nope')          → Route [nope] is not defined. Known: dashboard, login, register.
```

The second one lists what *is* defined, because a typo in a route name is the
usual cause and the list is the answer.

Declaring the name next to the route is what lets a page ask
`routes().path('login')` and get nothing when the auth kit was not installed —
which is how the welcome page shows sign-in links only when there is a sign-in
page. Both `:id` and `{id}` are accepted in a pattern.

## Route model binding

```ts
.get('/articles/:article', ({ params }) => view(Show, { article: params.article }))
```

A parameter named after a model is resolved to the record, and a missing one is a
404 before the handler runs. Scoped bindings work too — a child resolved *through*
its parent, so `/authors/:author/articles/:article` cannot reach another author's
article by id.

## Where routes come from

`routes/web.ts` is the entry point, and it is a plain Elysia instance. Packages
add their own: `@elvel/auth` mounts twelve endpoints under `config/auth.ts`'s
`basePath`, and `@elvel/view` serves `public/`. `route:list` shows everything with
the middleware each route carries:

```
METHOD   PATH                MIDDLEWARE
GET      /dashboard          auth
POST     /confirm-password   auth, throttle:6,1
GET      /forgot-password    guest
```
