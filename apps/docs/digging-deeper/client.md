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

- **`prefix`** is `/api` unless you clear it — where a client's reads live, and
  where a miss stays a JSON 404 rather than becoming a document. Addresses a browser
  navigates to are not under it.
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

## Forms, for Vue

`@elvel/client/vue` is the same client with Vue's reactivity around it — one subpath
so the root export stays framework-free and `vue` is an optional peer, installed only
by an application that has it anyway:

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
