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
