# Single-page applications

The client is an ordinary Vite project — `bun create vite` with nothing removed —
and the server renders the one document it boots from. There is no protocol between
them: no page object, no version header, no `X-` anything. The server answers a
document; after that the client asks for JSON like any other caller.

```ts
// bootstrap/providers.ts
export default [SpaServiceProvider, …]
```

```ts
// app/Providers/AppServiceProvider.ts
boot(): void {
  spa().payload(async () => ({
    user: user(),
    invoices: user() === null ? null : await firstPage(String(user().id))
  }))
}
```

```ts
// routes/web.ts — the only route the client needs
Route.get('/', () => document())
```

That is the whole server side. The payload is registered **once** and used by every
response that renders the document — which, in a client-routed application, is most
of them.

## Why the payload is registered rather than passed

Every address the client router owns arrives as a 404 and is answered with the same
document. If `/` built its payload and the 404 handler built another, a deep link
and the front page would boot from different data — a bug that only appears on
reload, and only for whoever reloads.

Add to it per page where a page genuinely knows more:

```ts
document({ title: 'Sign in', payload: { next: '/dashboard' } })
```

## What the document contains

```html
<script type="application/json" id="page-data">{"user":{…},"csrf":"…"}</script>
<div id="app"></div>
```

The data travels as **data**, in an inert `<script type="application/json">`, never
as an assignment to `window`. The browser does not execute that element, so nothing
inside a customer's name can redefine anything on the page. Inertia and Nuxt both
arrived at the same shape.

The CSRF token is added by the framework, not by your payload builder. Forgetting it
is not a visible mistake: the page renders, and the first write comes back 419 from
somewhere else entirely.

Asset tags come from `vite()`, and nothing in the document writes a `<script>` of
its own. That is load-bearing — `vite()` is what points at the dev server while one
is running, at the manifest afterwards, and what carries whatever the other Vite
plugins injected: the React Fast Refresh preamble, Vue DevTools, a service worker
registration. See [Views](/basics/views#what-the-other-vite-plugins-inject).

## The addresses only the client knows

`/invoices/9` is not missing — the client router owns it — so a reload on it has to
boot the application. `SpaServiceProvider` replaces the exception handler, and four
conditions decide whether a 404 becomes the document:

| condition | why |
| --- | --- |
| `GET` | a write to an address nothing serves is not a page |
| `Accept: text/html` | a client asking for JSON gets a parse error instead of an error |
| not under `spa.apiPrefixes` | a missing endpoint is a missing endpoint |
| no file extension | a stale `/build/assets/index-abc.js` must stay a 404, not become a page |

A 500 is still a 500. Only a 404 becomes a document.

### Or a route, if you would rather write one

```ts
Route.view('/', MainLayout, { title: 'Home' })
Route.view('/{path}', MainLayout, { title: 'Home' }).where('path', '.*')
```

This is Laravel's `Route::view('{path}', 'main')`, and it works: a request for a
path with no file on disk falls through to the router, in development exactly as
in production. It did not always — `@elysiajs/static` used to claim `/*` in
development and answer its own 404s, so the same source answered `/deep/link` in
production and 404 locally. `packages/view/test/static-fallthrough.test.ts` is
what keeps that fixed.

A route is the right shape when the catch-all needs **middleware** — an admin
panel behind `auth`, which an exception handler cannot express:

```ts
Route.middleware('auth').group(() => {
  Route.view('/admin/{path}', AdminLayout, { title: 'Admin' }).where('path', '.*')
})
```

What you give up is the four conditions above. A bare `/*` answers a page for
`/build/assets/index-abc.js` too, exactly as `Route::view('{path}', 'main')` does
in Laravel — so a stale asset URL renders HTML to a browser waiting for
JavaScript. Prefixed routes for the parts that need guarding, and the handler for
the global fallback, is the combination that keeps both.

An `onError` hook in a provider is the one shape that cannot work at all: the
framework wires its own handler into Elysia's error pipeline before any provider
registers, and the first handler to answer wins.

## The client

```ts
import { call, page, Invalid, Unauthenticated } from '@elvel/spa/client'

const invoices = await call<Page<Invoice>>('/invoices', { query: { status } })
```

Four things every request needs, decided once:

- **the cookie, not a token.** There is no `Authorization` header anywhere in that
  module. The session is an `HttpOnly` cookie the browser attaches itself — a token
  this code could read is a token an injected script could read, and one XSS would
  then be a stolen session rather than a bad afternoon.
- **`accept: application/json`.** Without it, an expired session sends `fetch`
  following a 302 to a document and `JSON.parse` fails on HTML — a parse error
  standing in for "you are signed out".
- **`x-csrf-token` on writes**, from the document. A cookie is attached to requests
  other sites can make; this token is not.
- **401 and 422 as types**: `Unauthenticated` for a router to act on, `Invalid`
  carrying `errors` per field for a form to render.

It imports nothing — not from the framework, and not from Vue, React or Svelte. It
is the same module whichever of those you chose.

Two options are worth knowing:

- `prefix` is `/api` unless you clear it. That default is the prefix
  `spa.apiPrefixes` hands the exception handler, so a 401 there arrives as JSON
  rather than as the document. Auth and settings are **not** under it — `/sign-in`
  and `/settings/profile` are addresses a browser navigates to as well — so a form
  posting to one passes `prefix: ''`.
- `token` overrides the CSRF token read from the document, for a shell that carries
  none.

## Forms

A form is where the client half and the server half have to agree, so the
agreement ships with the framework rather than being written per application:

```ts
import { useForm } from '@elvel/spa/vue'

const form = useForm({ email: '', password: '' }, { onRedirect: (to) => router.push(to) })

form.post('/sign-in')
```

```vue
<input v-model="form.data.email" />
<p v-if="form.errors.email">{{ form.errors.email }}</p>
<button :disabled="form.processing">Sign in</button>
```

- `form.data` holds the fields, and they stay under `data` rather than being
  hoisted onto the form. Hoisting reads better right up until an application has a
  field called `errors` or `post`, and then it shadows the form's own — a bug whose
  symptom is a submit button that does nothing.
- `form.errors` is **one message per field**, which is what fits under an input.
  The server sends all of them; `Invalid.errors` from `call()` still carries the
  rest for a summary.
- `form.processing` is true in flight and false afterwards *even when refused* —
  set in a `finally`, so a 422 cannot leave the button disabled forever.
- Errors clear **before** the request, not after. A field the server no longer
  objects to has to stop being red, and that is the only certain moment.
- `post`, `put`, `patch`, `delete`, plus `reset(...fields)` and
  `clearErrors(...fields)`.
- A **422 is an answer**, not a failure: `post()` resolves with `undefined` and
  fills `errors`. Anything else throws, `Unauthenticated` included — what a
  signed-out session means is the router's decision, not a form's.
- `onRedirect` is where navigation happens, and the package does not guess it.
  Signing in might mean the dashboard or a two-factor challenge, and only the
  server knows which; reaching for `location.assign` would throw away the client
  routing that made this a client in the first place.

## A shell, when the application has to be installable

```ts
// config/spa.ts
embed: false
```

The document then carries no payload and no token: the same bytes for everybody, and
therefore cacheable. That is what an installable, offline-capable application needs.

::: tip It is cacheable by a CDN too, and only recently
A shell used to arrive with a `Set-Cookie` on it — every visitor was given a session
whether the page used one or not — and a response carrying `Set-Cookie` is a response
no shared cache will store. `Cache-Control: public` and that header contradicted each
other on every response.

A session with nothing in it is no longer written and no longer named, so a guest
fetching a shell gets neither. Measured on the same server: the guest path went from
323 requests a second to 2,561, which is what it serves a static file at.
:::

It costs two requests before the first screen — who am I, and what am I looking at
— and the token has to come from somewhere else, because a token is per session and
would make the document per session again.

| | `embed: true` (default) | `embed: false` |
| --- | --- | --- |
| first paint | has content | has a spinner |
| requests before the first screen | none | two |
| `cache-control` | `no-store` | revalidated |
| a service worker may cache the document | no | yes |

One setting, not two packages. Which one is right is a property of the application.
