# Middleware

Middleware is named, and applied by name:

```ts
import { middleware } from '@elvel/http'

export default controller('dashboard')
  .get('/dashboard', handler, middleware('auth'))
  .post('/settings', handler, middleware('auth', 'verified', 'throttle:6,1'))
```

Everything registered, and where it is used:

```bash
bun elvel middleware:list
```

```
NAME              KIND   ROUTES  EXPANDS TO
auth              alias  5
bindings          alias  2
can               alias  1
guest             alias  1
locked-down       group  1       auth, verified, token
password.confirm  alias  0
signed            alias  2
throttle          alias  1
verified          alias  2
```

The `ROUTES` column is the useful part: a middleware at **0** is either dead or a
guard somebody forgot to apply, and both are worth knowing.

## What ships

| Name | What it does |
| --- | --- |
| `auth` | Signed in, or redirected — 401 for a JSON client |
| `guest` | Signed **out** only |
| `verified` | Email confirmed |
| `password.confirm` | Password typed recently; answers **423** |
| `can:ability` | An [authorization](/security/authorization) check |
| `throttle:max,minutes` | [Rate limiting](#rate-limiting) |
| `signed` | The URL's signature is valid, origin included |
| `signed:relative` | The same, ignoring the origin |
| `bindings` | Resolve route model bindings |

The two `signed` forms are a real choice, not a shorthand. `signed` covers the
origin, which is what a link in an email needs — and it therefore **cannot be
followed on a host `APP_URL` does not name**, including any ephemeral port, so a
preview deployment or a tunnelled localhost will reject its own links.
`signed:relative` ignores the origin and works anywhere.

Both sides have to agree. `signedRoute(name, params, expires)` mints the absolute
form; its fourth argument is `absolute`, so `signedRoute(name, params, expires,
false)` is the one `signed:relative` can verify. The first version of this shipped
the verifier without the minter, which made `signed:relative` a check nothing
could satisfy — mismatch the pair and that is what you get back.

## Registering your own

```ts
// in a provider's boot()
middlewares()
  .alias('subscribed', () => async ({ set }) => {
    if (!user()?.subscribed) set.status = 402
  })
  .group('locked-down', ['auth', 'verified', 'token'])
  .priority(['auth', 'verified'])
```

`bun elvel make:middleware EnsureSubscribed` writes the file.

A **group** is a name that expands to several, so a set of routes can say one
word. `middleware:list` shows what a group expands to, which is how you check that
`locked-down` still means what you think.

::: tip Only middleware applied through `middleware()` shows up in the listings
Elysia compiles a route's `beforeHandle` hooks into one anonymous chain, so a
route table cannot say *which* middleware guards what — only that some does.
`middleware()` tags its hook with a name, which is what lets `route:list` print a
middleware column and `middleware:list` count usage.

A hook you attach yourself with `.onBeforeHandle(...)` still runs, and still
protects the route; it simply has no name to report, so those two commands cannot
see it. If you want a guard to appear there, register it as an alias and apply it
with `middleware('subscribed')`.
:::

## Order is enforced, not assumed

```ts
middlewares().priority(['auth', 'verified'])
```

`auth` before `verified` is not a preference: `verified` reads the user that
`auth` guarantees, and reversed it reports "not verified" to a **guest** who
should have been sent to sign in. So a caller who writes
`middleware('verified', 'auth')` still gets the working order — route order alone
does not solve this, which is why Laravel keeps a priority list too.

## Rate limiting

```ts
controller('api')
  .use(throttle({ max: 60, decay: 60 }))
  .get('/orders', handler)
```

Or a named limiter, defined once in a provider:

```ts
limiters().for('uploads', ({ ip, user }) =>
  user?.id
    ? Limit.perMinute(500).by(String(user.id))
    : [Limit.perMinute(3).by(ip), Limit.perDay(50).by(ip)]
)
```

```ts
.use(throttle('uploads'))
```

Four things that follow:

- A refusal is **429** with `Retry-After` and `X-RateLimit-Reset`, so a client
  waits the right amount instead of guessing. Guessing is what turns a rate limit
  into a retry storm.
- Two windows over one subject get **two counters**, and the response reports the
  tightest remaining — the per-minute and per-day limits above are both live.
- `throttle()` is scoped to the plugin it is used in, so two route groups can
  have two budgets.
- The counters live in the cache and are the same ones `limiter()` reads, so a
  limit is visible to both HTTP and your own code. See
  [the cache page](/digging-deeper/cache#rate-limiting).

::: warning A limit checks and then increments, so a burst can slip past
Four simultaneous requests against `throttle:3,1` can all return 200: each reads
the counter before any of them has written to it. Laravel's `ThrottleRequests`
has the same shape, so this is its behaviour rather than a divergence — but it
matters if you are using a limit to stop a *burst* rather than a rate. What would
close it is an atomic increment-and-compare in the store, which is not what this
does today.

For the cases where the gap matters — a job that must not run twice, an API that
allows exactly three callers — use a [lock](/digging-deeper/cache#locks)
instead. A lock is atomic on every driver here.
:::

## CORS and proxies

CORS is driven by `config/cors.ts` — `paths` is the switch. Two behaviours worth
knowing: `*` is **never** sent for a credentialed request, and a refused origin
gets a normal response with **no CORS headers** rather than a 403. The browser is
the thing enforcing CORS; a 403 would only mislead whoever is reading the server's
logs.

`X-Forwarded-For` is believed only when it comes from a proxy named in
`http.trustedProxies`. Trusting it while directly exposed hands every caller a
fresh identity per request, which silently defeats every rate limit keyed by IP.

## Maintenance mode

```bash
bun elvel down --retry=60 --except=/health --with-secret
bun elvel down --render=errors.maintenance     # bake the page now, serve it later
bun elvel up
```

The payload lives in **a file**, because the reason to need maintenance mode is
often that the database or Redis is what broke.

`--with-secret` prints a URL that sets a bypass cookie — a MAC over the cookie's
own expiry, so the phrase never reaches the browser and a copied cookie expires by
itself. A scheduled entry is skipped while the application is down unless it says
`evenInMaintenanceMode()`.
