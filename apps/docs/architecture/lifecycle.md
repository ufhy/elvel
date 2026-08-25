# Request lifecycle and the container

## Boot, in order

`bootstrap/app.ts` runs seven steps, and the order is fixed by the framework
because each one needs the last. It mirrors `Illuminate\Foundation\Http\Kernel`:

```
1. env          → .env is read
2. config       → config/ is loaded, from bootstrap/cache/config.json if cached
3. exceptions   → the handler is installed
4. register     → every provider's register()
5. boot         → every provider's boot()
6. console      → schedules and commands
7. routes       → mounted last
```

Steps 6 and 7 are last for the same reason: a scheduled entry and a route handler
both need the container already populated, so they are collected after every
provider has booted rather than while they are still booting.

::: tip Step 3 comes before step 7, and an exception's headers depend on it
`handleExceptions()` installs the handler that turns a thrown `HttpException` into
a response — the status *and its headers*. It is an `onError` hook, and Elysia
applies a hook to the routes mounted after it, so wiring it late is the same as
not wiring it at all. Measured on the same application, throwing
`new HttpException(429, 'Too many', { 'Retry-After': '60' })`:

| when `handleExceptions()` runs | status | `Retry-After` |
| --- | --- | --- |
| before the routes | 429 | `60` |
| after the routes | 429 | missing |
| never | 429 | missing |

The status survives either way, which is what makes this quiet: a 429 with no
`Retry-After` reads as the rate limiter having forgotten the header rather than as
a hook registered one line too late.

`create()` has the order right, so an application booted the ordinary way never
meets this. It is worth knowing if you build one by hand — a test that constructs
`new Application(base)` and mounts routes on it needs `handleExceptions()` first.
:::

### Two lists of providers, and they are not the same list

**`bootstrap/providers.ts` holds the framework's**, one line per package:

```ts
export const providers = [
  EventServiceProvider,
  LogServiceProvider,
  HttpServiceProvider
  // …
]
```

`config/app.ts` reads that list, and **`withProviders()` in `bootstrap/app.ts`
takes your own**:

```ts
Application.configure(root)
  .withConfig({ … })
  .withProviders([AppServiceProvider])
```

Yours register **last**, so an application provider can override a framework
binding rather than fighting it.

Laravel keeps a `bootstrap/providers.php` too, for a different reason: there,
`laravel/framework` registers its own and the file lists only the application's.
Here every provider is named, because every one lives in a package of its own —
and that is the whole point of the file. **A provider named there is a package
imported, installed and bundled; one left out is a package the application never
pays for.** Measured, registering all twenty-two took a landing page from 1.0 MB
to 3.7 MB, most of it `kysely` behind the database, `nodemailer` behind mail, and
better-auth behind auth. It is the list a starter kit changes.

Events and logging come first, as Laravel's base providers do, because everything
booting after them may emit an event or write a line.

### Why `register` and `boot` are separate

**`register` may not resolve anything.** A provider that reads another binding
during `register` depends on registration order, which is exactly the bug the two
phases prevent. Declare in `register`, use in `boot`.

## The container resolves by token, not by reflection

```ts
app('view')       // → JsxViewFactory
app('queue')      // → QueueManager
app().make('db')  // the same thing, spelled out
```

```ts
app.bind('reports', () => new ReportBuilder())    // a fresh one each time
app.singleton('reports', () => new ReportBuilder())
app.instance('reports', builder)                  // one you already have
app.bound('reports')                              // is it registered?
```

Laravel's container reads a constructor's **parameter types** and resolves each
one. That cannot work here: TypeScript erases those types, and
`Reflect.getMetadata('design:paramtypes', …)` is `undefined` under Bun even with
`experimentalDecorators` and `emitDecoratorMetadata` both on — checked directly,
not assumed. So there is no autowiring, and asking for one would mean asking every
application to carry a metadata polyfill so the framework could guess what a token
already says outright.

The same erasure is why there are **no facades**. `Facade::method()` resolves a
name at runtime and gets its types from a docblock; keeping Elysia's end-to-end
inference matters more.

### Making a binding typed

```ts
declare module '@elvel/contracts' {
  interface ContainerBindings {
    reports: ReportBuilder
  }
}
```

Then `app('reports')` has a real type. It must stay an **`interface`** — a type
alias cannot be augmented, and the failure is a confusing "not assignable"
rather than anything pointing at the declaration.

## Writing a provider

```ts
import { ServiceProvider } from '@elvel/core'

export class ReportServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('reports', (app) => new ReportBuilder(app.make('db')))
  }

  override async boot(): Promise<void> {
    this.use(somePlugin)                        // mount Elysia routes
    this.commands(ReportBuildCommand)           // register a command
  }
}
```

`bun elvel make:provider ReportServiceProvider` writes one, and
`bootstrap/providers.ts` is where it goes.

`this.config('reports.disk', 'local')` reads configuration with a fallback, and
`this.app` is the application.

## Providers a package leaves out

`HttpServiceProvider` is the one worth naming. **Routing lives in `@elvel/core`** —
the root Elysia instance and `controller()` are there — so an application that
leaves the http provider out still serves pages, and loses sessions, cookies,
CSRF, the rate limiters and the middleware registry.

That is why `middleware('auth')` fails per request rather than at boot in such an
application, with a message that says which provider is missing instead of
`Target [middleware] is not bound in the container`.

## A request, once booted

The application is an Elysia instance, so a request runs Elysia's own pipeline:

```
request → middleware (beforeHandle) → validation → handler → response
```

with the framework's parts hooked in as plugins — the session and cookie jar, CSRF,
the static file server, CORS, the auth endpoints. `bun elvel route:list` shows what
that composition actually produced, which is the only honest answer once several
packages have added routes.

Errors are rendered by **one** handler, in `@elvel/core`. A second `onError` in the
http package once raced it and lost — which is how that was found, and why there is
only one.

### Replacing the handler

Bind your own over it, from a provider's `register`:

```ts
// app/Providers/AppServiceProvider.ts
register(): void {
  this.app.instance('exception.handler', new SpaExceptionHandler(this.app))
}
```

`render` may be async — the contract has always allowed `Promise<Response>` — which
is what lets a handler answer with a page it had to read a database for. Override
`shouldReport` to log a status the default leaves alone, or to silence one.

An `onError` hook registered by a provider is **not** the seam: the framework wires
its own into Elysia's error pipeline before any provider registers, and the first
handler to answer wins. Replace the handler instead.

### A response with no handler runs the rest of the lifecycle itself

The pipeline above belongs to a *route*. A response the exception handler produces
has none — nothing matched, or something threw on the way there — so `derive`,
`onBeforeHandle` and `onAfterHandle` never run, and everything they do is missing.
That does not matter while an error page is a paragraph of text. It matters
completely once an application renders a real page there, which a client-routed
application does for every address only its own router knows.

`request.lifecycle` is what the error path runs instead, in three steps:

| step | when | why it is separate |
| --- | --- | --- |
| `preparing` | before rendering | resolving a session or a user is async |
| `entering` | before rendering | `enterWith` must be called synchronously |
| `finishing` | after the response exists | saving is a write, and needs the status |

A package registers into it at boot: `@elvel/http` resolves the session, puts it in
scope and re-issues its cookie — if there is a session to name, since one nothing
wrote is neither saved nor cookied; `@elvel/auth` puts the signed-in user back.
Measured before it existed, on one cookie: `GET /api/user` answered as the user
while a document rendered by the 404 handler read guest, `csrf: ''`, and set no
cookie at all.

Nothing registered here may **answer**. A hook that returns a value in Elysia's
error pipeline pins the response, which would let the machinery describing an error
replace it.

## Why `bootstrap/app.ts` names every config file

```ts
export default await Application.configure(join(import.meta.dir, '..'))
  .withConfig({
    app: () => import('../config/app.ts'),
    session: () => import('../config/session.ts')
    // … one line per file
  })
```

Laravel needs no equivalent: PHP resolves `config/*.php` from disk on every
request and there is no build step to hide the directory from. Here there is —
and getting it wrong was not subtle. Left to scan `config/`, a **bundled**
application resolved those imports against a disk that may not have them and,
when it did, loaded a *second copy of the framework* through them, so
`Application.current` belonged to the copy that was not running.

Lazy imports so a config file can call `storage_path()` while it is evaluated;
literal ones because a bundler can follow an `import` and cannot follow a
directory read at run time. It is also what lets `app:build` drop the packages a
kit does not use.

[Configuration](/getting-started/configuration) has the rest.
