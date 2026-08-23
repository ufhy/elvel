# Session, cookies and CSRF

## Session

```ts
import { sessionOf } from '@elvel/http'

.post('/cart', ({ ...context }) => {
  const session = sessionOf(context)

  session.put('cart', items)
  session.get('cart')
  session.forget('cart')
})
```

`put`, `get`, `has`, `exists`, `all`, `forget`, `flush`, `pull`, `increment`.
`has` is false for a key holding `null`; `exists` is true — the distinction
Laravel draws, and the one you want when `null` is a real value.

### Flash data

```ts
session.flash('status', 'Saved.')
session.reflash()          // keep everything for one more request
session.keep(['status'])   // keep some of it
```

A flashed value survives **exactly one further request**, implemented with the
same `_flash.new` → `_flash.old` ageing Laravel uses. That is why nothing has to
clean up after a redirect: the value expires by being read once.

### A response with no handler still has a session

Every per-request hook — `derive`, `onBeforeHandle`, `onAfterHandle` — belongs to a
route, and a response the exception handler produces has none: nothing matched, or
something threw before the pipeline got there. That used to mean no session at all
on that path, which matters the moment an application renders a real page there. A
client-routed application does exactly that: the server cannot know which paths the
client router owns, so every one of them arrives as a 404 and leaves as a document.

Measured on a built application, one cookie, two requests:

| request | answered by | `csrfToken()` | `Set-Cookie` |
| --- | --- | --- | --- |
| a route | the handler | the session's | yes |
| a deep link | the 404 handler | **`''`** | **none** |

The second is the dangerous one: the client booted with a token belonging to a
session nobody stored, and nothing said so until the first write came back 419.

The error path now resolves the session, enters its scope, and — if there is
anything to save — saves it and re-issues the cookie. `request.lifecycle` is the
seam, and [Views](/basics/views) needs nothing for it: `csrfToken()`, `errors()`
and `old()` read the same scope they always did.

Two rules keep it honest, and both are about flash data:

- **Nothing saves twice.** A redirect built with flash data persists the session
  itself, and `save()` ages the flash — so saving again would drop what that save
  had just promoted, and the form would render with no messages.
- **A request that changed nothing saves nothing.** Ageing the flash of an
  untouched session consumes a message on its way to a page. A `419` for a missing
  token used to do exactly that, and so would a browser asking for a favicon that
  does not exist.

### Drivers

```ts
// config/session.ts
driver: env('SESSION_DRIVER', 'file'),
lifetime: Number(env('SESSION_LIFETIME', 7200)),
cookie: env('SESSION_COOKIE', 'elvel_session'),
```

`file`, `database`, `redis`, `cache` and `memory`.

::: warning `file` is right for one machine and wrong for two
The session lives on whichever container wrote it, so behind a load balancer half
the requests cannot find it and people are logged out at random — a failure that
looks like a bug in the auth code and is not. `database` needs
`bun elvel session:table && bun elvel migrate`.
:::

`enabled: false` turns the middleware off entirely, which is what a pure API
wants.

The `sessions` table's `last_activity` is **64-bit**, unlike Laravel's — see
[behaviours](https://github.com/ufhy/elvel/blob/main/BEHAVIOURS.md) for why a
32-bit one is a problem before 2038 rather than at it.

## Cookies

**Signed by default, and encryptable.** A signed value stays readable by the
client but cannot be altered without the key. The session cookie carries only an
opaque id, so signing is enough for it — nothing secret belongs in a cookie in
the first place.

```
SESSION_ENCRYPT=true
```

That encrypts it through `@elvel/encryption`, **bound to its own name**: the
cookie name is authenticated as the AEAD's associated data, so a value lifted out
of one cookie and dropped into another fails to decrypt.

Reading falls back from decrypt to unsign, so **turning encryption on does not log
everybody out** — the sessions already in the wild keep working until they expire.
An encrypted `X-XSRF-TOKEN` is still *rejected* rather than waved through, because
a header is not a cookie and treating one as the other is how a CSRF check gets
bypassed.

## CSRF

```tsx
<form method="post" action="/articles">
  {csrfField()}
  …
</form>
```

`csrfToken()` gives the raw value for a fetch call, as `X-CSRF-TOKEN`.

The check compares `_token` or `X-CSRF-TOKEN` against the session token in
**constant time**, exempts read methods and configured paths, and answers **419**
on a mismatch. Constant-time because a comparison that returns early leaks the
token one byte at a time to anybody willing to measure.

419 rather than 403 is Laravel's choice and a useful one: it means specifically
"your token expired", which a client can respond to by reloading the form rather
than by telling the user they are not allowed.

## The other half of an XSS defence

CSRF stops another site acting as your user. It does nothing about a script
injected into your own page, which is what a Content Security Policy is for — and
for a page that embeds a JSON payload, the two are read together. See
[security headers](/security/headers).

## Errors and old input

```tsx
<input name="email" value={old('email')} />
{errors().has('email') && <p class="error">{errors().first('email')}</p>}
```

Both read the request rather than taking props, because a JSX component has no
scope to share an `$errors` into. `errors('bag')` reads a named bag when one form
on a page has to keep its messages apart from another's.

[Requests and validation](/basics/requests#a-rejected-form-goes-back-to-itself)
has what gets flashed and what never does.
