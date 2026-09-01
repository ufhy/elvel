# Requests and validation

A `FormRequest` holds the rules for one incoming payload, and the order it runs
in is the part worth knowing.

```ts
import { FormRequest, validateRequest } from '@elvel/http'

class StoreArticleRequest extends FormRequest {
  authorize() {
    return true                        // false is a 403, never a 422
  }

  prepareForValidation() {
    this.merge({ title: String(this.input('title')).trim() })
  }

  rules() {
    return { title: 'required|min:3', status: 'required|in:draft,published' }
  }

  passedValidation() {
    // last chance to normalise
  }
}
```

```ts
.post('/articles', async ({ body, request }) => {
  const data = await validateRequest(StoreArticleRequest, { body, request })

  return Article.create(data)
})
```

`bun elvel make:request StoreArticleRequest` writes one.

## The order, and why it matters

```
prepareForValidation → authorize → rules → passedValidation
```

**Authorization is checked before the rules.** A refused request therefore cannot
reveal which fields *would* have failed — otherwise a 422 becomes an oracle for
somebody who is not allowed to be there at all.

`prepareForValidation` runs first so a rule sees the tidied value: trimming a
title before `min:3` is the difference between rejecting `"  a  "` and accepting
it.

## Reading what passed

```ts
data                          // only the keys a rule mentioned
request.safe().only(['title'])
request.safe().except(['status'])
```

`validated()` returns only validated keys, which is what stops an extra field in
the payload reaching a database write. `failOnUnknownFields` goes further and
**rejects** a payload carrying keys no rule mentions.

## A rejected form goes back to itself

Nothing about redirecting is written in the handler:

```ts
const data = await validateRequest(SubscribeRequest, { body, request })
```

The view reads the messages and the old input from the request rather than from
props:

```tsx
<input name="email" value={old('email')} />
{errors().has('email') && <p class="error">{errors().first('email')}</p>}
```

There are no props to thread through because a JSX component has no scope to
share an `$errors` into — `errors()` and `old()` read the request instead.

Four things that follow from it:

- **A browser is redirected; a client asking for JSON gets the 422 and the bag.**
  Asking counts as an `Accept` header, `X-Requested-With`, *or sending a JSON
  body* — a client that posts JSON and gets an HTML redirect has been handed a
  parse error instead of an error message. This holds for a redirect you built by
  hand as well, not only for a form request: `redirect().withErrors(...)` answers
  such a caller 422 `{ message, errors }` and writes nothing to the session, since
  a flash is read by the next document and that caller renders none. On success it
  answers `{ redirect }` for a router to act on, plus any other flash by its own
  key.

  The two disagree on one point, deliberately. A request with **no `Accept` at
  all** is read as a client by validation — no browser omits the header — and as a
  browser by a redirect, which is Laravel's reading. What is at stake decides it:
  a `Request` built without headers is a test, an internal dispatch or a health
  probe, and answering those with JSON silently breaks every redirect they rely
  on.
- `password`, `password_confirmation`, `current_password`, `token` and uploads are
  **never flashed**, at any depth.
- Flash data survives exactly one further request, so nothing has to clean up.
- `redirect('/x')`, `redirect().back()`, `.with()`, `.withErrors()`,
  `.withInput()`, `.seeOther()`, `.permanent()` build the rest by hand when you
  want to.

## A form reaching PUT, PATCH or DELETE

A browser form can only send `GET` or `POST`. Laravel's answer is a hidden
`_method` field, and this is the same one — Blade's `@method` is `methodField()`
here:

```tsx
<form method="post" action="/settings/profile">
  {csrfField()}
  {methodField('PATCH')}
  …
</form>
```

The route is a real `PATCH`, and nothing in the handler knows a form was involved:

```ts
Route.patch('/settings/profile', [ProfileController, 'update'])
```

Four things worth knowing:

- **The override happens before routing**, which is what makes it work at all.
  Elysia picks a handler from the method, and a `beforeHandle` hook runs after
  that choice — too late. `onRequest` runs first and hands the router a new
  request carrying the real method.
- **The body survives the round trip**, so validation and the CSRF check see what
  was actually sent.
- **Only `PUT`, `PATCH`, `DELETE` and `OPTIONS` can be claimed.** A form may not
  spoof `GET` or `HEAD`: turning an unsafe request into a cacheable one lets a
  proxy cache it and a browser repeat it, and every "this method is safe"
  assumption downstream would then be wrong. `allow` narrows the list further.
- **`?_method=` in the query string is ignored by default**, as in Symfony —
  `fromQuery: true` turns it on. `X-HTTP-Method-Override` is read for clients that
  cannot set a body field.

## Validating without a class

```ts
import { validate } from '@elvel/validation'

const data = await validate(body, { email: 'required|email' })
```

The [validation page](/basics/validation) has the rules, `unique`/`exists`, and
error bags.

## The path, without parsing a URL

```ts
import { requestPath, requestSearch, requestTarget } from '@elvel/core'

requestPath(request)     // '/photos/42'
requestSearch(request)   // '?page=2', or '' when there is none
requestTarget(request)   // '/photos/42?page=2'
```

`new URL(request.url).pathname` gives the same answers and costs more than the
route it is guarding. `request.url` is already absolute and already **normalised**
by the `Request` constructor — `/build/../.env` arrives as `/.env`, and
`/%2e%2e/secret` as `/secret` — so these read the string rather than building a
URL object. Eight plugins inside the framework each wrote the `new URL` form, and
a CPU profile put it at 4.2% of samples on a route that returns a constant.

Reach for a real `URL` when you mean to **change** it — adding a query parameter,
building a redirect. These are for the common case: comparing a path against a
prefix.

## Shaping a response

```ts
import { JsonResource } from '@elvel/http'

class ArticleResource extends JsonResource<Article> {
  toObject() {
    return {
      id: this.resource.id,
      notes: this.when(viewer.isEditor, () => this.resource.notes),
      comments: this.whenLoaded('comments'),
      links: this.merge({ self: `/articles/${this.resource.id}` })
    }
  }
}
```

A conditional key is **absent**, not null. That is the point: a `null` tells a
client the value exists and is empty, which is a different fact from "you may not
see this".

`whenLoaded` never triggers a lazy load — an eager-loading mistake shows up as a
missing key rather than as N+1 queries in production.

`bun elvel make:resource ArticleResource` writes one.

## Errors

One handler renders them, in `@elvel/core`. `ValidationError` carries
`status = 422` and its bag is picked up duck-typed, so a package can throw
something bag-shaped without importing the validator. A second `onError` in the
http package once raced the first and lost — which is how that was found, and why
there is only one now.

The redirect a rejected form produces is thrown, not returned: validation happens
inside a handler, several frames from anywhere a `Response` could go back. So it
travels as an exception that **carries** its response, and two things read that
exception's status — the log and the response itself.

Which is why it is not reported. A thrown redirect is control flow, and only 5xx
is worth a log line: every rejected form used to write `ERROR [stack] Redirecting
to /subscribe` with a stack trace through `failedValidation`, for a browser on its
way back to the form it came from. 4xx says the caller got it wrong and the answer
already told them; 3xx says nothing went wrong at all.
