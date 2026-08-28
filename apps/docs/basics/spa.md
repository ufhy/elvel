# Single-page applications

The client is an ordinary Vite project — `bun create vite` with nothing removed —
and the server renders the one document it boots from. There is no protocol between
them: no page object, no version header, no `X-` anything. The server answers a
document; after that the client asks for JSON like any other caller.

No package is involved. The document is a view, the addresses are routes, and the
client is [`@elvel/client`](/digging-deeper/client) — which imports nothing from the
framework at all.

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
sends a stranger to it — two routes because one cannot carry both guards.

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

::: tip A shell is cacheable by a CDN too, and only recently
A shell used to arrive with a `Set-Cookie` on it — every visitor was given a session
whether the page used one or not — and a response carrying `Set-Cookie` is a response
no shared cache will store. `Cache-Control: public` and that header contradicted each
other on every response.

A session with nothing in it is no longer written and no longer named, so a guest
fetching a shell gets neither. Measured on the same server: the guest path went from
323 requests a second to 2,561, which is what it serves a static file at.
:::

## The client

```ts
import { http, Invalid, Unauthenticated } from '@elvel/client'

const invoices = await http.get<Page<Invoice>>('/invoices', { query: { status } })
```

Four things every request needs, decided once:

- **the cookie, not a token.** There is no `Authorization` header anywhere in that
  module. The session is an `HttpOnly` cookie the browser attaches itself — a token
  this code could read is a token an injected script could read, and one XSS would
  then be a stolen session rather than a bad afternoon.
- **`accept: application/json`.** Without it, an expired session sends `fetch`
  following a 302 to a document and `JSON.parse` fails on HTML — a parse error
  standing in for "you are signed out".
- **`x-csrf-token` on writes.** A cookie is attached to requests other sites can
  make; this token is not.
- **401 and 422 as types**: `Unauthenticated` for a router to act on, `Invalid`
  carrying `errors` per field for a form to render.

It imports nothing — not from the framework, and not from Vue, React or Svelte. It
is the same module whichever of those you chose.

Two options are worth knowing:

- `prefix` is `/api` unless you clear it. Addresses a browser also navigates to are
  not under it, so a form posting to one passes `prefix: ''`.
- `token` overrides the CSRF token read from the document, for a shell that carries
  none.

File uploads, cancelling a request, reading a status or a header, and the rest of the
surface are in [Browser client](/digging-deeper/client).

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
profile answered from a shared cache is the worst bug in this document. `generateSW`
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

## Forms

A form is where the client half and the server half have to agree, so the
agreement ships with the framework rather than being written per application:

```ts
import { useForm } from '@elvel/client/vue'

const form = useForm({ email: '', password: '' }, { onRedirect: (to) => router.push(to) })

form.post('/sign-in')
```

```vue
<input v-model="form.data.email" />
<p v-if="form.errors.email">{{ form.errors.email }}</p>
<button :disabled="form.processing">Sign in</button>
```

Three things are worth knowing here, and the rest of the surface — every method, the
error bag's shape, and the other two options — is in
[Browser client](/digging-deeper/client#forms-for-vue).

- A **422 is an answer**, not a failure: `post()` resolves with `undefined` and fills
  `errors`. Anything else throws, `Unauthenticated` included — what a signed-out
  session means is the router's decision, not a form's.
- `form.processing` is false afterwards *even when refused*, so a 422 cannot leave the
  button disabled forever.
- `onRedirect` is where navigation happens, and the package does not guess it. Signing
  in might mean the dashboard or a two-factor challenge, and only the server knows
  which.
