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
export default controller('app').get('/', () => document())
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

Three earlier shapes are recorded in the source because each looked right and none
worked: a `GET /*` route loses to the static file plugin, registering it earlier
shadows every real file, and an `onError` hook in a provider never fires — the
framework wires its own handler in before any provider registers.

A 500 is still a 500. Only a 404 becomes a document.

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

## A shell, when the application has to be installable

```ts
// config/spa.ts
embed: false
```

The document then carries no payload and no token: the same bytes for everybody, and
therefore cacheable. That is what an installable, offline-capable application needs.

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
