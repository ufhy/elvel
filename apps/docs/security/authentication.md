# Authentication

Elvel does not implement authentication. It wraps
[better-auth](https://better-auth.com) over its own query builder, and adds the
parts that belong to the framework: routes, middleware, the session, mail, and
a typed `user()`.

That division is deliberate. Password hashing, token rotation, verification links
and session revocation are a security surface with a long tail of subtle
mistakes, and writing a second one is not a service to anybody.

## The quickest way in

```bash
bun create elvel my-app --kit=auth
```

That gives you sign-in, sign-up, password reset, password confirmation, email
verification, a dashboard, and profile and password settings — every page a
`.tsx` file in your application, every route in a controller you can read. The
[starter kits page](/getting-started/starter-kits) has what each kit costs.

## The tables are generated, not shipped

**What the tables are depends on `config/auth.ts`** — the options and plugins you
enable decide the columns. So they are generated:

```bash
bun elvel auth:schema
bun elvel migrate
```

```
 INFO  Migration created: database/migrations/2026_08_21_015849_create_auth_tables.ts
Review it, then run: elvel migrate
```

Run `auth:schema` again after changing `config/auth.ts` and it writes a migration
for the **difference**, not the whole table again.

`bun elvel auth:secret` writes `AUTH_SECRET`, which signs better-auth's tokens.
It is not `APP_KEY` and must never be the same value: one signs sessions, the
other encrypts data, and a single key doing both means a leak of either is a leak
of both.

## Configuration

```ts
// config/auth.ts
export default {
  // --- what the framework reads
  mount: env('AUTH_MOUNT', true),   // serve the auth endpoints; off leaves only the Gate
  connection: undefined,             // which database connection the tables live on

  // --- everything else goes to better-auth verbatim
  secret: env('AUTH_SECRET', ''),
  baseURL: env('APP_URL', 'http://localhost:3000'),
  basePath: '/api/auth',
  emailAndPassword: { enabled: true, minPasswordLength: 8 }
}
```

Only `mount` and `connection` are ours. Everything else is passed to better-auth
unchanged, so **its documentation is the reference** for what goes in there —
social providers, two-factor, passkeys, organisations. Twelve endpoints are
mounted under `basePath`, which `bun elvel route:list` will show you.

::: tip Every endpoint is off until the options say otherwise
better-auth ships nothing enabled by default. A sign-up route that 404s usually
means `emailAndPassword.enabled` is not set, not that something is broken.
:::

## Reading the current user

```ts
import { requireUser, session, user } from '@elvel/auth'

user()         // the user, or null
session()      // the session record, or null
requireUser()  // the user, or throws — for code that runs behind `auth`
```

In a view:

```tsx
import { whenAuth, whenGuest } from '@elvel/auth'

{whenAuth((user) => `<span>${user.name}</span>`)}
{whenGuest(() => '<a href="/sign-in">Log in</a>')}
```

In a handler that has the request context, `userOf(context)` reads it from there
rather than from the ambient scope — which matters in a websocket handler, where
there is no request.

## Middleware

```ts
export default controller('dashboard').get('/dashboard', handler, middleware('auth'))
```

| Middleware | What it does |
| --- | --- |
| `auth` | Signed in, or redirected to sign-in |
| `guest` | Signed **out** only — so a signed-in visitor does not see the sign-in form |
| `verified` | Email confirmed |
| `password.confirm` | Re-entered their password recently |
| `can:ability` | Passes an authorization check — see [Authorization](/security/authorization) |

Measured against a scaffolded auth kit:

```
GET /sign-in    → 200            (guest)
GET /dashboard  → 302 → /sign-in (auth)
```

The redirect only happens for a browser. A request that asks for JSON — an
`accept` naming `/json` or `+json`, or `x-requested-with: XMLHttpRequest` — gets
**401** instead, because redirecting an API client to an HTML form is a bug that
surfaces as a parse error somewhere far away.

`auth.redirectGuestsTo` in `config/auth.ts` changes where a browser is sent;
`/sign-in` is the default.

`password.confirm` is the one worth explaining: it guards an action that is
dangerous even while signed in — deleting an account, changing an email. A
session open for hours is not proof the person at the keyboard is still the
owner. It answers **423 Locked** rather than 403, because the caller is not
forbidden — they need to do something first, and a client can tell those apart.

## Acting as a user in tests

```ts
await test(app).actingAs(user, async (request) => {
  ;(await request.get('/dashboard')).assertOk()
})
```

Restored afterwards even when an assertion throws, so one test cannot leave
another authenticated. The [testing page](/testing/getting-started#acting-as-a-user)
has the rest.

## Mail

Verification and password-reset mail goes out through `@elvel/mail`, and the
provider fills in better-auth's `sendVerificationEmail` and its relatives for
you. Write your own in `config/auth.ts` to take one over — the notification
classes are yours to edit, as they are in your application, not in the framework.

## Changing an email address

better-auth keeps this behind its own endpoint — `POST /change-email` — because
`updateUser` refuses an `email` outright. With a **verified** address on file the
change waits for a link sent to the *old* inbox; an **unverified** one is
replaced at once, since there is nothing to protect yet and a typo at sign-up
would otherwise be unfixable.
