# Browser client

`@elvel/client` is one `fetch` with the four decisions every request to your own
backend needs already made. It imports nothing — not the framework, not Vue, React
or Svelte — so it is the same module whichever of those you chose, and it adds no
server code to a browser bundle.

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

## What it decides for you

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

## The verbs

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

## Queries

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

## Bodies

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

## Cancelling

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

## Errors that mean something

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

## The whole answer

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

## The two options worth knowing

```ts
// A form posting to an address a browser also navigates to.
await http.post('/sign-in', { body: credentials, prefix: '' })

// A shell carries no token in its document, so it is fetched and passed.
await http.post('/settings/profile', { body: details, token: csrf() })
```

- **`prefix`** is `/api` unless you clear it. That default is the prefix
  `spa.apiPrefixes` hands the exception handler, so a 401 under it arrives as JSON
  rather than as a document. Addresses a browser navigates to are not under it.
- **`token`** overrides the CSRF token read from the document — for a shell, which
  carries none because a document carrying a per-session token could not be cached.
- **`headers`** is merged last, so a caller can override any default above.

## Wrapping it once

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

## Reading the payload a document carried

With `spa.embed` on, the server renders the first screen's data into the document
and the client reads it without a request:

```ts
import { page } from '@elvel/client'

const { user } = page as { user?: User }
```

It comes from an inert `<script type="application/json">` rather than a global the
server assigned: a JSON script tag is not executed, so nothing inside it can define
or overwrite anything on the page. Empty in shell mode, and empty where there is no
document at all — a test, a build script, server-side rendering — so importing this
module outside a browser does not throw.
