# Routing

Routes are declared in `routes/web.ts`, and the file exports nothing.

```ts
// routes/web.ts
import { Route } from '@elvel/http'
import PageController from '../app/Http/Controllers/PageController.ts'

Route.get('/', [PageController, 'index']).name('home')
Route.get('/health', [PageController, 'health'])
```

That is Laravel's `routes/web.php`, and the resemblance is the point: `Route`
collects what the file declares while it is being imported, and the framework
compiles the collection once the file has finished. Nothing to export, and nothing
to remember to mount.

The compilation step is what makes the fluent part work. `.name()` and `.where()`
arrive *after* the route they describe, so there has to be something still open to
modify — a router that registered on the spot would have nothing left.

## The verbs

```ts
Route.get(uri, action)
Route.post(uri, action)
Route.put(uri, action)
Route.patch(uri, action)
Route.delete(uri, action)
Route.options(uri, action)

Route.any(uri, action)                        // every verb
Route.match(['get', 'post'], uri, action)     // these two
```

A verb the route did not name answers **404**, not 405 — the same as Laravel's.

## What a route runs

Three forms, all of them Laravel's:

```ts
Route.get('/users/{id}', [UserController, 'show'])       // a controller method
Route.get('/ping', () => ({ ok: true }))                 // a closure

Route.controller(OrderController).group(() => {
  Route.get('/orders/{id}', 'show')                      // the method by name
  Route.post('/orders', 'store')
})
```

A controller is a plain class. Each method receives Elysia's request context, so
`{ params, query, body, request, set }` is destructured from its argument:

```ts
export default class UserController {
  show({ params }: { params: { id: string } }) {
    return view(User, { id: params.id })
  }
}
```

One instance is built per route and reused — not one per request. Laravel resolves
a controller out of the container per request because a PHP process serves one
request at a time; here a per-request instance would be a new object on every hit
for a class that almost never has state, and state on a controller is a bug either
way. Keep them stateless.

## Parameters

```ts
Route.get('/users/{id}', [UserController, 'show'])         // required
Route.get('/posts/{id?}', [PostController, 'show'])        // optional
Route.get('/posts/{post:slug}', [PostController, 'show'])  // bound by a column
```

`{post:slug}` is the binding-field syntax: the parameter still arrives as `post`,
and [route model binding](#route-model-binding) resolves it by `slug` instead of by
the key.

`defaults()` fills one the URI did not carry:

```ts
Route.get('/reports/{format?}', [ReportController, 'show']).defaults('format', 'pdf')
```

## Constraints

```ts
Route.get('/users/{id}', handler).where('id', '[0-9]+')
Route.get('/users/{id}', handler).whereNumber('id')

Route.get('/c/{a}/{b}', handler).where({ a: '[0-9]+', b: '[a-z-]+' })
```

The shorthands are `whereNumber`, `whereAlpha`, `whereAlphaNumeric`, `whereUuid`,
`whereUlid` and `whereIn(name, values)`. A global default for every parameter of a
name is `Route.pattern`, which belongs in a provider's `boot`:

```ts
Route.pattern('id', '[0-9]+')      // every {id} in the application
```

A route's own `where` beats the global one.

::: warning One difference from Laravel
In Laravel a constraint is part of **matching**: `/users/{id}` restricted to digits
and `/users/{slug}` can both exist, and a non-numeric id falls through from the
first to the second. Here a failed constraint is a **404** instead.

This is a limit of the router underneath, not a decision. Registering both routes
and handling a request answers:

```
Cannot create route "/users/:slug" with parameter "slug" because a route already
exists with a different parameter name ("id") in the same location
```

The pair cannot coexist at all, so there is nothing to fall through to. Closing
the gap means replacing Elysia's router — and the typed context, schema validation
and speed that come with it. Everything else about `where` behaves as Laravel's
does.
:::

## A route that only renders, and a route that only redirects

```ts
Route.view('/', Welcome, { title: 'Home' })
Route.redirect('/here', '/there')             // 302
Route.permanentRedirect('/old', '/new')       // 301
```

`Route.view` takes a component and its props. It renders through the container, so
an application that never registered `ViewServiceProvider` gets a container error
naming `view` rather than a mystery.

## Names

```ts
Route.get('/sign-in', [SignInController, 'create']).name('login')
```

```ts
route('login')                      // '/sign-in'
route('users.show', { id: 12 })     // '/users/12'
route('users.index', { page: 2 })   // '/users?page=2'  — leftovers become a query
route('users.show', { id: 12 }, true)   // absolute, for a mail
```

A name is worth the indirection because the path is written in a dozen places and
changed in one. A duplicate name is refused rather than overwritten, and a name
pointing at a path no route answers is a **startup failure** — `routes().verify()`
compares the table against what Elysia actually registered. A rename that misses a
name fails at boot; a rename that misses a path produces a 404 nobody sees until
somebody finds it.

`Route.has('login')` asks whether a name exists, which is what a starter page needs:
a link to sign in must not be rendered by an application that has no sign-in.

## Groups

Every group attribute chains, in any order, and nests:

```ts
Route.prefix('admin')
  .name('admin.')
  .middleware('auth')
  .group(() => {
    Route.get('/', [AdminController, 'index']).name('index')   // admin.index → /admin

    Route.prefix('reports').group(() => {
      Route.get('/daily', [ReportController, 'daily'])          // /admin/reports/daily
    })
  })
```

The attributes are `prefix`, `name` (and `as`, its Laravel alias), `middleware`,
`withoutMiddleware`, `domain`, `controller`, `where` and the `where*` shorthands,
`scopeBindings`, `withoutScopedBindings` and `missing`. The object form works too:

```ts
Route.group({ prefix: 'admin', middleware: 'auth' }, () => { … })
```

A group's name is a **prefix** joined to each route's own, which is why group names
end in a dot.

## Metadata

Values a *page* knows about itself, with nowhere else to live:

```ts
Route.metadata({ head: { robots: ['noindex'] } }).group(() => {
  Route.get('/users', [UserController, 'index']).metadata({ head: { title: 'Users' } })
})
```

```ts
import { current } from '@elvel/http'

current()?.getMetadata('head.title')     // 'Users'
current()?.getMetadata('head')           // { robots: ['noindex'], title: 'Users' }
current()?.getMetadata('head.robots', ['index'])   // with a fallback
```

A route's metadata merges **over** its group's, key by key and deeply. Two rules
are not what the merge suggests, and both come from Laravel's own tests:

- a **list replaces** a list — `robots: ['index', 'follow']` under
  `robots: ['noindex']` leaves `['noindex']`, not three entries
- an **empty object clears** rather than inherits, which is the only way for one
  route to escape a group's value

Reachable through `current()` is the point of it. A layout asking for
`head.title` three components below the handler cannot be handed it through props
without every component in between carrying it — and that is the plumbing that
makes people hard-code the title instead.

## Middleware

```ts
Route.get('/dashboard', [DashboardController, 'index']).middleware('auth')
Route.post('/sign-in', [SignInController, 'store']).middleware('throttle:6,1')

Route.middleware('auth').group(() => { … })
```

One route can opt out of what its group added:

```ts
Route.middleware('auth').group(() => {
  Route.get('/public', handler).withoutMiddleware('auth')
})
```

`can` is spelt as Laravel spells it, over the middleware `@elvel/auth` registers:

```ts
Route.put('/posts/{post}', [PostController, 'update']).can('update', 'post')
```

See [Middleware](/basics/middleware) for the aliases and how to add your own.

## Validation

Laravel has no `->validate()` on a route, and this framework does, because Elysia's
schemas type the handler's `body` — a mistyped field name is a compile error rather
than an `undefined` two layers later:

```ts
import { t } from 'elysia'

Route.post('/sign-in', [SignInController, 'store']).validate({
  body: t.Object({ email: t.String(), password: t.String() })
})
```

Anything Elysia's hooks accept works: `body`, `query`, `params`, `headers`,
`response`, `cookie`. A failure comes back as a 422 with the error bag, the same
shape a [FormRequest](/basics/validation) gives — and validation runs *before*
middleware, so a guard never sees a body that failed its schema.

## Resource routes

```ts
Route.resource('photos', PhotoController)
```

Seven routes, with Laravel's URIs, verbs and names:

| Verb | URI | Method | Name |
| --- | --- | --- | --- |
| GET | `/photos` | `index` | `photos.index` |
| GET | `/photos/create` | `create` | `photos.create` |
| POST | `/photos` | `store` | `photos.store` |
| GET | `/photos/{photo}` | `show` | `photos.show` |
| GET | `/photos/{photo}/edit` | `edit` | `photos.edit` |
| PUT/PATCH | `/photos/{photo}` | `update` | `photos.update` |
| DELETE | `/photos/{photo}` | `destroy` | `photos.destroy` |

Two details are from `ResourceRegistrar`'s source rather than from the
documentation, and both matter: `update` answers **PUT and PATCH** — a form
spoofing PATCH against a PUT-only route is a 405 nobody expects — and the parameter
is the resource name **singularised**, because `$singularParameters` is `true`.

```ts
Route.apiResource('photos', PhotoController)        // no create, no edit
Route.resource('photos', PhotoController).only(['index', 'show'])
Route.resource('photos', PhotoController).except(['destroy'])
Route.resource('photos', PhotoController).names({ index: 'gallery' })
Route.resource('photos', PhotoController).parameters({ photos: 'photo_id' })
Route.resource('photos', PhotoController).middleware('auth')

Route.resources({ photos: PhotoController, posts: PostController })
Route.apiResources({ photos: PhotoController })
```

Nested resources are written with a dot, and `shallow()` drops the parent where an
id already identifies the child:

```ts
Route.resource('photos.comments', CommentController)
// /photos/{photo}/comments/{comment}

Route.resource('photos.comments', CommentController).shallow()
// /photos/{photo}/comments        for index, create and store
// /comments/{comment}             for show, edit, update and destroy
```

A shallow resource is also *named* by its own segment — `comments.show`, not
`photos.comments.show`.

### Singletons

One of a thing, so no index and no identifier in the URI:

```ts
Route.singleton('profile', ProfileController)              // show, edit, update
Route.singleton('profile', ProfileController).creatable()  // + create, store, destroy
Route.singleton('profile', ProfileController).destroyable() // + destroy
Route.apiSingleton('profile', ProfileController)           // no edit

Route.singletons({ profile: ProfileController })
```

## Route model binding

Declare what a parameter means, then ask for it:

```ts
// A provider's register()
bindings().model('article', Article)
bindings().bind('kind', (value) => KINDS[value])
```

```ts
Route.get('/articles/{article}', [ArticleController, 'show']).middleware('bindings')
```

```ts
export default class ArticleController {
  show() {
    return view(Show, { article: bound<Article>('article') })
  }
}
```

Declared rather than inferred from a type hint, which Laravel can do and this
cannot: TypeScript erases types and Bun emits no decorator metadata to put them
back. `Route::model()` is Laravel's own explicit form and this is that.

A middleware rather than something automatic: a route that takes an id and does not
want the row loaded should not pay for a query.

### `{post:slug}`, `scopeBindings()` and `missing()`

```ts
Route.get('/posts/{post:slug}', [PostController, 'show']).middleware('bindings')
```

```ts
Route.get('/photos/{photo}/comments/{comment}', [CommentController, 'show'])
  .middleware('bindings')
  .scopeBindings()
```

`scopeBindings()` resolves the child **through its parent**, so a comment is found
among *that photo's* comments — resolving it alone would hand somebody else's
comment to a caller who guessed an id, which reads as a working route and is an
authorization hole. The parent and the relation are read off the URI, which is why
it takes no arguments: `comment`'s parent is `photo`, and the relation is the
segment in front of it, `comments`.

```ts
Route.get('/posts/{post}', [PostController, 'show'])
  .middleware('bindings')
  .missing(() => redirect('/posts').toResponse())
```

Without `missing()` a binding that resolves to nothing is a 404, which is right for
a page and wrong for a form that should send somebody back to the index with a
message. It catches only that: an exception from the handler's own work is a real
failure and stays one.

```ts
Route.post('/posts/{post}/restore', [PostController, 'restore'])
  .middleware('bindings')
  .withTrashed()
```

`withTrashed()` lets a soft-deleted row resolve — the screen that restores one has
to be able to find it.

## A catch-all, and the fallback

A client-side router owns addresses the server has no routes for. Laravel writes
that as `Route::view('{path}', 'main')` with `where('path', '.*')`, and so does
this:

```ts
Route.view('/{path}', MainLayout, { title: 'App' }).where('path', '.*')
```

`.*` is the one constraint that changes matching rather than filtering: it compiles
to a wildcard, because `:path` matches a single segment. A prefixed wildcard also
answers the prefix itself — `/admin/{rest}` answers `/admin` — because Laravel's
does and a panel whose own front page 404s is a gap found in production.

`Route.fallback` is the other form, and it differs in one way worth knowing:

```ts
Route.fallback(() => view(NotFound, {}))
```

It answers **every verb**. A hand-written `Route.get('/{path}')` answers a form
submission to a missing address with the framework's own 404 page, which is the
wrong answer and a confusing one.

Both work in development exactly as in production. That was not always true: the
static file plugin used to claim `/*` in development and answer its own misses, so
an application whose only catch-all was `.get('/*')` served `/deep/link` in
production and 404 locally, from one source. Static files are not routes — nginx is
`try_files $uri $uri/ /index.php` and Valet is `file_exists(...) ? path : false` —
and the plugin is now mounted to match. See [Views](/basics/views#static-files).

## Domains

```ts
Route.domain('{account}.example.com').group(() => {
  Route.get('/dashboard', [DashboardController, 'index'])
})
```

The host's parameters join the path's, so `params.account` is `acme` for
`acme.example.com`.

::: warning A limitation
Elysia's router keys on the path alone, so this is a guard rather than part of
matching: a host that does not match gets a 404 rather than falling through to the
next route. One group whose paths are shared across every host — a tenant
subdomain, which is what this is for — is unaffected. Two domain groups claiming the
**same path** cannot both work.
:::

## Which route is answering

```ts
import { currentRouteName, currentRouteNamed, currentRouteUri } from '@elvel/http'

currentRouteName()                  // 'photos.show'
currentRouteNamed('photos.*')       // true — `*` matches as Str::is does
currentRouteUri()                   // '/photos/{photo}'
```

This exists for the thing every layout needs and nothing else can supply: a
navigation component deciding which link is active, three components below the
handler, without the name being threaded through props. A component that reads
`location.pathname` instead breaks the moment the path changes, which is the whole
reason routes have names.

## More than one routes file

A file per area, which is how Laravel's own starter kits are laid out:

```ts
// bootstrap/app.ts
  .withRoutes(() => import('../routes/web.ts'))
  .withRoutes(() => import('../routes/auth.ts'))
  .withRoutes(() => import('../routes/settings.ts'))
```

Nineteen routes in one file is what `routes/web.php` became before Breeze split it,
and somebody looking for the settings pages should find a file called settings.

Order matters, and usefully: files are mounted in the order they are named, and the
**last registration of a path wins**. That is how the Vue starter kit replaces the
seven server-rendered auth *pages* with SPA shells while every action — the POST
that calls better-auth, rotates the session and copies the cookie — stays in the
auth kit's own routes file, unedited and uncopied.

A kit adds a route file by adding the file: `create-elvel` finds anything in
`routes/` that is not `web.ts` or `console.ts` and names it in `bootstrap/app.ts`.

## Listing them

```
bun elvel route:list
bun elvel route:list --method=post
bun elvel route:list --path=settings
bun elvel route:list --middleware=auth
bun elvel route:list --assets          # include the files under public/
```

Files in `public/` are routes — the static plugin registers one per file so a path
with no file falls through to the router — and listing them is noise, so they are
hidden unless asked for. Decided by asking the filesystem rather than by matching
path prefixes: the build directory is configurable and `public/` can hold anything,
so a prefix list would be wrong in both directions.
