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
  parse error instead of an error message.
- `password`, `password_confirmation`, `current_password`, `token` and uploads are
  **never flashed**, at any depth.
- Flash data survives exactly one further request, so nothing has to clean up.
- `redirect('/x')`, `redirect().back()`, `.with()`, `.withErrors()`,
  `.withInput()`, `.seeOther()`, `.permanent()` build the rest by hand when you
  want to.

## Validating without a class

```ts
import { validate } from '@elvel/validation'

const data = await validate(body, { email: 'required|email' })
```

The [validation page](/basics/validation) has the rules, `unique`/`exists`, and
error bags.

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
