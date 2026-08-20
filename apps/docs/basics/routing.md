# Routing and controllers

Routing, controllers, requests, responses, middleware and CSRF — the parts of
an application that touch a request.

`FormRequest` completes the validation story, in the order
`ValidatesWhenResolvedTrait` defines: `prepareForValidation` → `authorize` →
rules → `passedValidation`.

```ts
class StoreArticleRequest extends FormRequest {
  authorize() { return true }          // false is a 403, never a 422
  prepareForValidation() { this.merge({ title: String(this.input('title')).trim() }) }
  rules() { return { title: 'required|min:3', status: 'required|in:draft,published' } }
}

const data = await validateRequest(StoreArticleRequest, { body })
```

Authorization is checked **before** the rules, so a refused request cannot reveal
which fields would have failed. `validated()` returns only validated keys;
`safe().only()/except()` slices it. `failOnUnknownFields` rejects keys no rule
mentions.

`JsonResource` makes a conditional key **absent** rather than null — a null tells
a client the value exists and is empty:

```ts
class ArticleResource extends JsonResource<Article> {
  toObject() {
    return {
      id: this.resource.id,
      notes: this.when(viewer.isEditor, () => this.resource.notes),
      comments: this.whenLoaded('comments'),        // never lazily loads
      links: this.merge({ self: `/articles/${this.resource.id}` })
    }
  }
}
```

```ts
article.tags()            // morphToMany: the pivot stores this model's type
  .withPivot('added_by')  // read the extra column back, onto `tag.pivot`
  .withTimestamps()       // and stamp it on attach

tag.articles()            // morphedByMany: the pivot names the *related* type
```

```ts
Article.query().chunkById(500, handle)    // by key: safe to delete while walking
Article.query().cursorPaginate(15, cursor)
await user.saveQuietly()                  // no model events

user.latestOfMany(Post, 'created_at')     // one per parent, even eagerly loaded
country.hasOneThrough(Post, User)         // one row across an intermediate table
```

`latestOfMany` joins a grouped subquery rather than ordering and limiting: a limit
is right for one parent and wrong for an eager load, where it answers the whole set
once. The key is aggregated with the column so a tie on `created_at` cannot make a
"one" relation return two.

Pivot columns are selected as `pivot_<column>` and moved onto the accessor after
hydration, so a pivot's `created_at` cannot overwrite the model's own. `using()`
hydrates them as a `Pivot` subclass of your own, and `as()` renames the accessor.

Sessions are driver-based (`file`, `memory`) with Laravel's flash semantics: a
flashed value survives exactly one further request, implemented with the same
`_flash.new` → `_flash.old` ageing. CSRF compares `_token` or `X-CSRF-TOKEN`
against the session token in **constant time**, exempts read methods and
configured paths, and answers 419 on a mismatch.

**Cookies are signed by default, and can be encrypted.** A signed value stays
readable by the client but cannot be altered without the key; the session cookie
carries only an id, so signing is enough for it. Setting `SESSION_ENCRYPT=true`
encrypts it instead, through `@elvel/encryption`, **bound to its own name** — the
cookie name is authenticated as the AEAD's associated data, so a value lifted into
a different cookie fails to decrypt. Reading falls back from decrypt to unsign, so
turning encryption on does not log everybody out. An encrypted `X-XSRF-TOKEN` is
still *rejected* rather than waved through.

```bash
bun elvel down --retry=60 --except=/health --with-secret   # 503, but /health still answers
bun elvel down --render=errors.maintenance                 # bake the page now, serve it later
bun elvel up
```

Maintenance mode keeps its payload in **a file**, because the reason to need it is
often that the database or Redis is what broke. `--with-secret` prints a URL that
sets a bypass cookie — a MAC over the cookie's own expiry, so the phrase never
reaches the browser and a copied cookie expires by itself. A scheduled entry is
skipped while the application is down unless it says `evenInMaintenanceMode()`.

A rejected form goes **back to itself**, with the messages and what was typed:

```ts
// In the handler: nothing about redirecting is written here.
const data = await validateRequest(SubscribeRequest, { body, request })
```

```tsx
// In the view: no props threaded through, because a component has no scope to
// share `$errors` into — `errors()` and `old()` read the request instead.
<input name="email" value={old('email')} />
{errors().has('email') && <p class="error">{errors().first('email')}</p>}
```

- a browser is redirected; a client asking for JSON — by `Accept`, by
  `X-Requested-With`, or by *sending a JSON body* — still gets the 422 and the bag
- `password`, `password_confirmation`, `current_password`, `token` and uploads are
  never flashed, at any depth
- flash data survives exactly one further request, so nothing has to clean up
- `redirect('/x')`, `redirect().back()`, `.with()`, `.withErrors()`, `.withInput()`,
  `.seeOther()`, `.permanent()`

```ts
await queue()
  .batch([new ImportRow(1), new ImportRow(2)])
  .name('nightly import')
  .onSuccess(NotifyFinished)   // a job class, not a closure
  .onFailure(AlertOncall)
  .dispatch()
```

A batch counts its jobs down in a table, so several workers agree on the progress.
The callbacks are **job classes**: a closure cannot be rebuilt in the worker that
would run it, and naming a job means the callback gets retries and a failure record
too. They are `onSuccess`/`onFailure`/`onFinished` rather than Laravel's
`then`/`catch`/`finally`, because a class with a `then` member is a thenable and
`await`ing the builder would call it with `resolve` instead of a job. The first failure cancels the rest unless `allowFailures()`, and a cancelled
batch's remaining jobs are skipped when reserved — a driver cannot reach in and
delete them.

`maxExceptions` is counted in the cache, keyed by the payload's uuid: a job with
`tries = 25` and `maxExceptions = 3` is one expected to be released often but which
should still give up when it is actually broken.

Rate limiting, CORS and trusted proxies are middleware:

```ts
controller('api')
  .use(throttle({ max: 60, decay: 60 }))        // or throttle('api'), a named one
  .get('/orders', () => …)

limiters().for('uploads', ({ ip, user }) =>      // in a provider's boot()
  user?.id ? Limit.perMinute(500).by(String(user.id)) : [Limit.perMinute(3).by(ip), Limit.perDay(50).by(ip)]
)
```

- a refusal is **429** with `Retry-After` and `X-RateLimit-Reset`, so a client
  waits the right amount instead of guessing — guessing is what turns a rate limit
  into a retry storm
- two windows over one subject get two counters, and the response reports the
  tightest remaining
- `throttle()` is scoped to the plugin it is used in: one per `routeGroup()` when
  two routes need two budgets
- CORS is driven by `config/cors.ts`; `paths` is the switch, `*` is never sent for
  a credentialed request, and a refused origin gets a normal response with no CORS
  headers rather than a 403
- `X-Forwarded-For` is believed only from a proxy named in `http.trustedProxies` —
  trusting it while directly exposed hands every caller a fresh identity per
  request

Errors are rendered by **one** handler, in core: `ValidationError` carries
`status = 422` and its bag is picked up duck-typed. A second `onError` in the http
package raced the first one and lost, which is how that was found.
