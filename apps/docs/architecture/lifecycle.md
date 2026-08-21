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
