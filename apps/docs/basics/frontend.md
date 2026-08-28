# Building a frontend

Two ways, and the framework does not prefer one. A page can be **rendered by the
server** — JSX in `resources/views/`, which is [Views](/basics/views) — or the
server can answer one document and hand everything after it to a **client project**.

This page is the second one, end to end: the Vite project, the document it boots
from, the routes that serve it, the client that talks back, forms, and what it takes
to make the result installable.

Choose the client when navigation between screens should not reload the page, or when
the application has to work offline. Choose server rendering when it does not — it is
less machinery, and a form that posts and redirects is a smaller thing than a form
that fetches. The `auth` and `jsx` starter kits are the first; `vue` is the second.

No package is involved in the *shape*. The document is a view, the addresses are
routes, and the client is `@elvel/client` — which imports nothing from the framework
at all. There is no protocol between the two halves: no page object, no version
header, no `X-` anything. The server answers a document; after that the client asks
for JSON like any other caller.

## The client project

```
my-app/
├── app/, routes/, config/     the application
├── resources/views/           the document, and any page the server renders
└── frontend/                  a `bun create vite` project
    ├── package.json           its own dependencies
    ├── vite.config.ts         your plugins, plus `elvel()`
    └── src/                   the client
```

`frontend/` is an ordinary Vite project. Every Vite tutorial, upgrade guide and
plugin applies to it verbatim, because there is nothing framework-specific in it
beyond one plugin — `@elvel/vite`, which finds the application by walking up for
`elvel.ts`, writes the hot file the server reads, and builds into `public/build`.
Swapping Vue for something else is swapping that directory.

```ts
// config/vite.ts
projectDirectory: 'frontend'
```

That is what `elvel dev` reads to know where to start Vite. The default is `.`, which
is the scaffold — `vite.config.ts` beside `elvel.ts`, client source in `resources/`.
One `bun install` covers both: the application's manifest names `frontend` in its
`workspaces`, so its dependencies land in a `node_modules` of its own rather than
resolving by accident through the application's.

## The document is a view

```tsx
// resources/views/components/shell.tsx
import { config } from '@elvel/core'
import { vite } from '@elvel/vite/tags'

export function Shell({ entry }: { entry: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title safe>{config<string>('app.name', 'Elvel')}</title>
        {vite([entry])}
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>
        <div id="app" data-spa-root />
      </body>
    </html>
  )
}
```

A document is markup, so it belongs in `resources/views/` with the other markup.
That is not a style preference: changing the icon, the title or the mount point is
then an edit to a file the application owns, rather than a search through a
framework package for the option that renders it.

Asset tags come from `vite()`, and nothing here writes a `<script>` of its own. That
is load-bearing — `vite()` points at the dev server while one is running, at the
manifest afterwards, and carries whatever the other Vite plugins injected: the React
Fast Refresh preamble, Vue DevTools, a service worker registration. See
[Views](/basics/views#what-the-other-vite-plugins-inject).

::: tip Mount on a marker, not on the id
`main.ts` mounts on `[data-spa-root]`, not on `#app`, so the client and the document
need no agreement about a string. Renaming the id otherwise leaves the client
hunting for a `<div>` that is not there — no error, no console message, the
application simply never appears.
:::

## The addresses only the client knows

`/invoices/9` is not missing — the client router owns it — so a reload on it has to
boot the application. One route says so:

```ts
// routes/view.ts
Route.view('/{path}', Shell, { entry: 'src/main.ts' }).where('path', '.*')
```

This is Laravel's `Route::view('{path}', 'main')`, and it works: a request for a path
with no file on disk falls through to the router, in development exactly as in
production. It did not always — `@elysiajs/static` used to claim `/*` in development
and answer its own 404s, so the same source answered `/deep/link` in production and
404 locally. `packages/view/test/static-fallthrough.test.ts` is what keeps that
fixed.

**Exact routes win over the wildcard**, measured with both registered, so `/health`
and every `/api` endpoint still answer for themselves.

A route rather than an exception handler, because a route can carry **middleware** —
which is where every guard that used to sit on a page has gone:

```ts
Route.prefix('auth').middleware('guest').group(() => {
  Route.view('/{path}', Shell, { entry: 'src/auth.ts' }).where('path', '.*')
})

Route.middleware('auth').group(() => {
  Route.view('/{path}', Shell, { entry: 'src/main.ts' }).where('path', '.*')
})
```

`guest` turns somebody already signed in away from the sign-in screen and `auth`
sends a stranger to it — two routes because one cannot carry both guards. Two
entries, too, which is the point of splitting them: a guest downloads the auth forms
and not the application behind them.

**The page list lives in one place, and that place is the client.** The router in
`frontend/src/` knows the addresses; the server knows two wildcards. Adding a screen
is one file and one router line, with nothing to add on the server.

An `onError` hook in a provider is the one shape that cannot work at all: the
framework wires its own handler into Elysia's error pipeline before any provider
registers, and the first handler to answer wins.

### What a wildcard must not swallow

A bare catch-all answers a page for `/build/assets/index-abc.js` too, exactly as
`Route::view('{path}', 'main')` does in Laravel — so a stale asset URL renders HTML
to a browser waiting for JavaScript. Two claims take those prefixes back:

```ts
// routes/api.ts — a mistyped endpoint stays a 404 a fetch can read
Route.any('/{path}', () => { throw new NotFoundException() }).where('path', '.*')
```

`@elvel/vite` does the other one for you: `vite.guardBuildDirectory` mounts an
`onRequest` hook that turns a miss under the build directory into a 404 before the
router sees it. It has to be a hook rather than a route — providers boot before the
routes file loads, so a route registered by a package loses to a wildcard registered
by the application.

## What the client asks for

The document carries no data and no CSRF token: the same bytes for everybody, and
therefore cacheable — which is what an installable, offline-capable application
needs. Two questions are asked on boot instead: who is this, and what is this screen
looking at.

```ts
// routes/api.ts
Route.prefix('api').group(() => {
  Route.get('/session', [SessionController, 'show']).name('api.session')

  Route.middleware('auth').group(() => {
    Route.get('/settings/profile', [SettingsController, 'profile'])
  })
})
```

`GET /api/session` is the one endpoint that must have no guard. The document carries
no token — a token is per session, and a document carrying one could not be cached —
so without an unguarded way to fetch it the sign-in form has nothing to post.
Measured as `419 CSRF token mismatch` on a fresh visit. `user: null` is a real answer
there, not a failure.

Cacheable has to be **said**, and the view route is where it is said:

```ts
// the guest half: nothing about it depends on who is asking
Route.view('/{path}', Shell, { entry: 'src/auth.ts' }, 200, {
  'cache-control': 'public, max-age=0, must-revalidate'
}).where('path', '.*')

// behind `auth`: the bytes are impersonal, but whether they exist is not
Route.view('/{path}', Shell, { entry: 'src/main.ts' }, 200, {
  'cache-control': 'private, max-age=0, must-revalidate'
}).where('path', '.*')
```

Laravel's fourth and fifth arguments to `Route::view`, and the fifth is the one with
a job here: a view returns markup rather than a response, so a route that renders is
the only place a header can be named. Without it the shell goes out with no
`cache-control` at all and every cache is left guessing at freshness — which is
exactly what a service worker's navigation cache cannot work with.

`private` for the guarded half is a deliberate downgrade. What depends on the cookie
is not the bytes but whether the response exists — a guest gets a 302 — and a shared
cache that served the signed-in shell while revalidating would be answering for the
guard. Nothing can do that today, because the response carries no `ETag` and
`must-revalidate` then leaves a cache no choice but to forward; `private` is what
keeps that true after somebody adds one.

::: warning A route's own headers win over the framework's
The security headers are applied only where a response does not already carry one —
`set.headers[name] ??= value` — so a header named here **replaces** the framework's.
Measured: a route answering `content-security-policy: default-src *` and
`x-frame-options: ALLOWALL` kept both. That is what makes a per-route policy possible
at all, and it means a typo in this argument is a silently weakened policy. Name cache
directives here; leave the security headers to `config/security.ts`.
:::

::: tip A shell is cacheable by a CDN too, and only recently
A shell used to arrive with a `Set-Cookie` on it — every visitor was given a session
whether the page used one or not — and a response carrying `Set-Cookie` is a response
no shared cache will store. `Cache-Control: public` and that header contradicted each
other on every response.

A session with nothing in it is no longer written and no longer named, so a guest
fetching a shell gets neither. Measured on the same server: the guest path went from
323 requests a second to 2,561, which is what it serves a static file at.
:::

## Talking to the backend

`@elvel/client` is one `fetch` with the decisions every request to your own backend
needs already made. It imports nothing — not the framework, not Vue, React or
Svelte — so it is the same module whichever of those you chose, and it adds no server
code to a browser bundle.

```ts
import { http } from '@elvel/client'

const invoices = await http.get<Page<Invoice>>('/invoices', { query: { status } })
```

That is `GET /api/invoices?status=…`, sent with the session cookie, asking for JSON,
and throwing a typed error rather than handing you a 401 to interpret.

::: tip This is the browser half
`@elvel/http-client` is the other direction — your server calling somebody else's
API, with retries, `sink` and redirects. This one runs in the browser and talks to
your own backend.
:::

### What it decides for you

| | |
| --- | --- |
| `credentials: same-origin` | the session is an `HttpOnly` cookie the browser attaches itself |
| `accept: application/json` | so an expired session is a 401, not a redirect to a page |
| `content-type` on writes | JSON — except for a form, see [Bodies](#bodies) |
| `x-csrf-token` on writes | read from the document, per request |
| `/api` prefix | where a client's reads live |
| 401, 422, 423 | thrown as types a router and a form can act on |

**There is no `Authorization` header anywhere in the module**, and that is the point.
A token this code could read is a token an injected script could read, and one XSS
would then be a stolen session rather than a bad afternoon.

### The verbs

```ts
import { http } from '@elvel/client'

await http.get<Invoice>(`/invoices/${id}`)
await http.post('/invoices', { body: { total: 1200 } })
await http.put(`/invoices/${id}`, { body: invoice })
await http.patch(`/invoices/${id}`, { body: { paid: true } })
await http.delete(`/invoices/${id}`)
```

Each is `call()` with `method` filled in. `call()` itself is there when the method
is a variable, and every option below works on all of them.

### Queries

```ts
await http.get('/invoices', {
  query: { status: 'paid', ids: [1, 2], page: 2, live: true, cursor: null }
})
// → /api/invoices?status=paid&ids=1&ids=2&page=2&live=true
```

Numbers and booleans are stringified. `null` and `undefined` are **dropped** rather
than sent as their own names — `URLSearchParams` unaided writes `cursor=null`, which
is a filter for the word "null", the one thing an absent filter must not become.

An array repeats its key — `ids=1&ids=2` — and that is the only form the backend can
read, which is worth stating because the `ids[]=` convention many clients use does
not work here. Measured against a running application:

| Sent | Route says nothing | Route declares `t.Array` |
| --- | --- | --- |
| `?ids=1&ids=2` | `{ ids: '2' }` — last wins | `{ ids: ['1', '2'] }` |
| `?ids[]=1&ids[]=2` | `{ 'ids[]': '2' }` | **422** — no `ids` key at all |

So reading one back as an array means the route has to declare it:

```ts
Route.get('/invoices', [InvoiceController, 'index']).validate({
  query: t.Object({ ids: t.Array(t.String()) })
})
```

Without that declaration the query parser answers strings, and only the last value
survives.

### Bodies

An object is sent as JSON. A `FormData`, `Blob`, `URLSearchParams`, `ArrayBuffer` or
string is sent as it is:

```ts
const form = new FormData()

form.append('avatar', file)
form.append('crop', JSON.stringify(box))

await http.post('/profile/avatar', { body: form })
```

**No `content-type` is set for those**, deliberately. A multipart body carries a
boundary the runtime decides once it has the form; a hand-written
`multipart/form-data` header survives and the far end then cannot parse the body,
with nothing failing on this side.

### Cancelling

```ts
const controller = new AbortController()

watch(term, () => {
  controller.abort()
  results.value = await http.get('/search', { query: { q: term.value }, signal: controller.signal })
})
```

A screen that navigates away has nothing to do with the answer, and a search box
firing per keystroke has several answers it does not want. Without a signal the only
way to ignore one is to check a flag after it lands, which still pays for the
transfer.

### Errors that mean something

```ts
import { http, Invalid, NeedsPasswordConfirmation, Unauthenticated } from '@elvel/client'

try {
  await http.post('/invoices', { body: draft })
} catch (problem) {
  if (problem instanceof Invalid) {
    errors.value = problem.errors // { total: ['Must be a number.'] }

    return
  }

  if (problem instanceof Unauthenticated) return location.assign('/sign-in')
  if (problem instanceof NeedsPasswordConfirmation) return askForPassword()

  throw problem
}
```

| Status | Thrown | What it means |
| --- | --- | --- |
| 401 | `Unauthenticated` | the session went away while the page was open |
| 422 | `Invalid` | validation failed; `errors` is the bag, per field |
| 423 | `NeedsPasswordConfirmation` | behind `password.confirm`, and the window closed |
| anything else | `Error` | with the server's `message` when it sent one |

A `204` is not a parse error — an empty body answers `{}` rather than throwing.

### The whole answer

`call()` and the verbs hand back the body, which is what most code wants. When the
status or a header *is* the answer, use `send()`:

```ts
import { send } from '@elvel/client'

const { data, status, headers } = await send<{ id: number }>('/invoices', {
  method: 'POST',
  body: draft
})

if (status === 201) router.push(headers.get('location') ?? '/invoices')
```

### The two options worth knowing

```ts
// A form posting to an address a browser also navigates to.
await http.post('/sign-in', { body: credentials, prefix: '' })

// A shell carries no token in its document, so it is fetched and passed.
await http.post('/settings/profile', { body: details, token: csrf() })
```

- **`prefix`** is `/api` unless you clear it — where a client's reads live, and
  where a miss stays a JSON 404 rather than becoming a document. Addresses a browser
  navigates to are not under it.
- **`token`** overrides the CSRF token read from the document — for a shell, which
  carries none because a document carrying a per-session token could not be cached.
- **`headers`** is merged last, so a caller can override any default above.

### Wrapping it once

An application usually wants one place where its own decisions live. The Vue starter
kit does exactly this — the shell has no token in its document, so every call has to
carry the one fetched from `GET /api/session`:

```ts
// frontend/src/api.ts
import { call, type CallOptions } from '@elvel/client'

export const ask = <T>(path: string, options: CallOptions = {}) =>
  call<T>(path, { token: current.csrf, ...options })

export const api = {
  profile: () => ask<{ name: string; email: string }>('/settings/profile'),
  sessions: () => ask<{ sessions: Session[] }>('/settings/sessions')
}
```

Everything else was already decided. What is left for an application is the token
and the paths.

## Forms

A form is where the two halves have to agree, so the agreement ships with the
framework rather than being written per application. `@elvel/client/vue` is the same
client with Vue's reactivity around it — one subpath so the root export stays
framework-free and `vue` is an optional peer, installed only by an application that
has it anyway:

```ts
import { useForm } from '@elvel/client/vue'

const form = useForm({ email: '', password: '' })

await form.post('/sign-in')
```

```vue
<input v-model="form.data.email" />
<p v-if="form.errors.email">{{ form.errors.email }}</p>
<button :disabled="form.processing">Sign in</button>
```

### The form

| | |
| --- | --- |
| `form.data` | the fields, bound with `v-model="form.data.email"` |
| `form.errors` | **one message per field** — what fits under an input |
| `form.processing` | true while a submission is in flight |
| `post` `put` `patch` `delete` | each takes a path and returns the answer, or `undefined` |
| `submit(method, path)` | the same, when the method is a variable |
| `reset(...fields)` | back to the values it started with — all, or only those named |
| `clearErrors(...fields)` | the same shape, for the error bag |

The fields stay under `data` rather than being hoisted onto the form. Hoisting reads
better right up until an application has a field called `errors` or `post`, and then
it shadows the form's own — a bug whose symptom is a submit button that does nothing.

`form.errors` keeps the first message per field, because that is the one an input has
room for. The server sends all of them, and `Invalid.errors` from `call()` still
carries the rest for a summary.

`form.processing` goes false afterwards *even when refused* — it is set in a
`finally`, so a 422 cannot leave the button disabled forever. And errors clear
**before** the request, not after: a field the server no longer objects to has to stop
being red, and that is the only certain moment.

### A 422 is an answer

```ts
const answer = await form.post('/sign-in')

// answer === undefined  →  refused, and form.errors is filled
```

`post()` resolves with `undefined` and fills `errors` rather than throwing, because a
validation failure is an answer. Anything else still throws, `Unauthenticated`
included — what a signed-out session means is a router's decision, not a form's.

### The three options

```ts
const form = useForm(
  { email: '', password: '' },
  {
    onRedirect: (to) => router.push(to),
    onSuccess: (payload) => toast(payload.message as string),
    token: () => csrf()
  }
)
```

- **`onRedirect`** is where navigation happens, and the package does not guess it.
  Signing in might mean the dashboard or a two-factor challenge, and only the server
  knows which; reaching for `location.assign` would throw away the client routing
  that made this a client in the first place. Left unset, a redirect is reported and
  nothing moves.
- **`onSuccess`** gets everything the server answered, redirect included — for the
  cases where the answer is more than "it worked".
- **`token`** is where the CSRF token comes from when the document carries none, and
  it is a **function** rather than a string on purpose: it is read per submission,
  because signing in rotates the session id and the token rotates with it. A value
  captured when the form was created is the wrong one by the time it submits.

## Reading a payload the document carried

A document may render the first screen's data into itself, and the client then reads
it without a request. The convention is one element, with the id `page-data`:

```tsx
// in your document view
<script type="application/json" id="page-data" safe>
  {JSON.stringify({ csrf: session().token(), user: user() })}
</script>
```

```ts
import { page } from '@elvel/client'

const { user } = page as { user?: User }
```

A `csrf` key there is read automatically on every write, which is what makes the
`token` option unnecessary for a document that carries one.

`page` is captured once, when the module evaluates, which is right in a browser: one
document per page load. `embedded()` is the same read performed again, and it is what
`call()` uses for the token — a module can be imported before the document it belongs
to exists, and one small query per write costs nothing next to the request:

```ts
import { embedded } from '@elvel/client'

const { csrf } = embedded()
```

It has to be an inert `<script type="application/json">` rather than a global the
server assigns: a JSON script tag is not executed, so nothing inside a customer's
name can define or overwrite anything on the page. Inertia and Nuxt both arrived at
the same shape.

`page` is empty when there is no such element — a shell, which carries nothing so
that a cache may keep it — and empty where there is no document at all: a test, a
build script, server-side rendering. So importing this module outside a browser does
not throw.

## Installable — a progressive web app

Two lines of yours, and one key. The client half is `vite-plugin-pwa` with nothing
framework-specific about it:

```ts
// frontend/vite.config.ts
VitePWA({
  registerType: 'autoUpdate',
  scope: '/',
  manifest: { name: 'My app', scope: '/', start_url: '/', display: 'standalone' }
})
```

```ts
// config/vite.ts
serviceWorker: 'sw.js'
```

Nothing else. `vite()` already renders the tags that plugin injects — it harvests
them from the project's own `index.html` during the build, which is the mechanism
described in [Views](/basics/views#what-the-other-vite-plugins-inject) — so the
`<link rel="manifest">` and `registerSW.js` reach the document without a line in the
view:

```html
<link rel="manifest" href="/build/manifest.webmanifest">
<script id="vite-plugin-pwa:register-sw" src="/build/registerSW.js"></script>
```

### What the config key is for

A service worker may claim no more than the directory it is served from, and Vite
writes it into the build directory. So `/build/sw.js` controls `/build/` — every URL
a client-routed application does not use. Measured in Chromium without the key:

```
The path of the provided scope ('/') is not under the max scope allowed
('/build/'). Adjust the scope, move the Service Worker script, or use the
Service-Worker-Allowed HTTP header to allow the scope.
```

The browser names all three remedies and only the header leaves the build output
where the build put it. Naming the file sends `Service-Worker-Allowed` for it, and
`cache-control: no-cache` with it — `sw.js` carries no content hash, so nothing about
its name changes when it does, and a worker cached is an application frozen at
whichever worker it deployed first. Measured after the key was turned on: scope `/`,
state `activated`, controlling the page, from a script at `/build/sw.js`.

::: warning `no-cache` is not `no-store`
It means revalidate before use. The worker is still cached; the browser just asks
first, which is the only way a second deployment ever reaches anybody.
:::

### A server-rendered kit needs its two tags written

The harvest above needs an `index.html` to harvest *from*, and only a client project
has one — `frontend/` in the Vue kit is `bun create vite` output. The `jsx` and
`auth` kits run Vite at the application root with no such page, so nothing is
harvested and the tags never reach a document. Measured on a scaffolded `jsx`
application: `sw.js`, `registerSW.js`, `manifest.webmanifest` and the Workbox runtime
are all emitted exactly as before, and no `injected-tags.txt` is written.

So write them into your layout. Both names are stable — no content hash — which is
why this is two lines and not a lookup:

```tsx
<link rel="manifest" href="/build/manifest.webmanifest" />
<script src="/build/registerSW.js" defer />
```

The server half is identical in every kit: `serviceWorker: 'sw.js'` in
`config/vite.ts`, measured answering `Service-Worker-Allowed: /` and
`cache-control: no-cache` on a scaffolded `jsx` application too.

### Two things that are still yours to decide

**`/api` must never be cached.** Those responses carry a session — one person's
profile answered from a shared cache is the worst bug on this page. `generateSW`
adds no runtime caching by default, so nothing is cached until you write a rule; when
you write one, exclude `/api` explicitly rather than by omission.

**Offline navigation needs a fallback that exists.** The document is rendered by the
server, so there is no `index.html` in the build to precache — `@elvel/vite`
deliberately deletes it, because two documents in one application is one too many.
Workbox's default still binds a navigation route to that name:

```js
// in the generated sw.js, measured
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")))
```

It fails over to the network, so an online application works and nothing appears in
the console — measured, a navigation to a client-only address while the worker was in
control rendered normally. What it means is that **offline navigation does not work
yet**: there is nothing behind that fallback. Reaching for one means caching the
shell at runtime rather than precaching it, since only the server can produce it:

```ts
workbox: {
  navigateFallback: null,
  runtimeCaching: [
    {
      urlPattern: ({ request, url }) =>
        request.mode === 'navigate' && !url.pathname.startsWith('/api'),
      handler: 'NetworkFirst',
      options: { cacheName: 'documents' }
    }
  ]
}
```

That is the shape the cacheable shell was built for: the same bytes for everybody,
`must-revalidate`, no `Set-Cookie` — a document a cache is allowed to hold.

One measured caveat before you count on a CDN: the shell carries **no `ETag`**, and
`must-revalidate` without a validator leaves a shared cache nothing to revalidate
*with*, so it forwards every request. The header is honest signalling rather than
reuse. A service worker does not care — it stores the response itself and decides
when to go back — but if you want the CDN half too, the route has to answer a
validator.

One more trap worth naming before you reach for it: a write queued offline and
replayed later by background sync carries the CSRF token it was queued with, and
signing in rotates that token. A replayed write arrives `419`.
