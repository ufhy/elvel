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

## Adding a better-auth plugin

Two lines. `config/auth.ts` passes everything it does not recognise straight to
better-auth, so a plugin goes in there and the framework does not need to know
about it:

```ts
// config/auth.ts
import { twoFactor } from 'better-auth/plugins'

export default {
  // …
  plugins: [twoFactor()]
}
```

```bash
bun elvel auth:schema
bun elvel migrate
```

`auth:schema` asks the built better-auth instance for its schema rather than
carrying a list of tables, so a plugin's contribution arrives on its own. All
three shapes it can take are handled:

```ts
await schema.create('user', (table) => {
  // …
  table.boolean('twoFactorEnabled').nullable()   // a column on a table it does not own
})

await schema.create('twoFactor', (table) => {    // a table of its own
  table.string('id').primary()
  table.string('secret').index()
  table.text('backupCodes')
  table.string('userId').index()
  // …
})

await schema.create('account', (table) => {
  // …
  table.unique(['issuer', 'accountId'])          // and an index no column can declare
})
```

That last one is a **compound** index, declared on the table rather than on any
one field. better-auth 1.7 scopes an account's identity to `(issuer, accountId)`
that way, and plugins use the same shape. A column named in one is emitted as
`varchar` rather than `text`, for the reason `session.token` is: MySQL will not
key a `TEXT` column.

Then the plugin's endpoints are live under `basePath`:

```
POST /api/auth/two-factor/enable  →  200
{"totpURI":"otpauth://totp/…?secret=GFBGGQ…&digits=6&period=30",
 "backupCodes":["1X2Hq-Zr6l5","e0cdS-ryei8", …]}
```

Run `auth:schema` again after adding a second plugin: it writes a migration for
the **difference**, not the whole schema again.

### Three things to know

**The pages are still yours to write.** A plugin gives you endpoints, not a UI.
The auth kit ships sign-in, sign-up, reset, verification and settings pages; a
two-factor challenge screen is not among them, so enabling the plugin gives you a
working API and a page you have to build.

**`config:cache` will skip that file.** A plugin is an object holding functions,
and a cached config is JSON. `optimize` says so rather than freezing something
wrong:

```
config/auth.ts holds a function at [auth.plugins.0] — read live.
```

Everything else stays cached; that one file is read at boot.

**Rename the plugin's table if it collides.** A plugin's table takes its own name
— `twoFactor`, not prefixed — and it accepts an override the same way the core
tables do:

```ts
twoFactor({ schema: { twoFactor: { modelName: 'user_two_factor' } } })
```

Plugin schemas are tested against SQLite, Postgres and MySQL on every push, by
generating the migration and **running** it — which is how a `text` column
carrying a unique constraint was found to be illegal in MySQL.

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
