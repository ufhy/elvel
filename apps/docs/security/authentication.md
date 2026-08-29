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
bun create elvel my-app --kit=jsx
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

After changing `config/auth.ts`, ask for the **difference** rather than the whole
schema again — `auth:schema` on its own always writes a full `create`, which an
application that has already migrated cannot run:

```bash
bun elvel auth:schema --diff
bun elvel migrate
```

`--diff` compares the configuration against the database it is pointed at, so it
sees a missing table, a missing column and a missing index alike.

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

Adding a second plugin is `auth:schema --diff` again, and the difference is
whatever that plugin asked for — a table, a column on a table it does not own, or
an index:

```
$ bun elvel auth:schema --diff
  twoFactor: *
  user: twoFactorEnabled
 INFO  Migration created: database/migrations/2026_08_22_034605_add_two_factor.ts
```

Run it with nothing outstanding and it says so rather than writing an empty
migration: `The auth tables already match the configuration.`

::: tip Upgrading better-auth is the same command
better-auth 1.7 added the `(issuer, accountId)` index to a table every existing
application already has, and `--diff` writes both halves — the column as
`varchar`, then the index. A stepwise upgrade ends up with the same schema as a
fresh install; that is asserted against SQLite, Postgres and MySQL by running the
migration rather than reading it.
:::

### Three things to know

**The pages are still yours to write.** A plugin gives you endpoints, not a UI.
The kits with accounts are the exception for exactly two: `twoFactor` and `passkey` are
enabled in their `config/auth.ts` and they ship the pages both need — TOTP
enrolment with a QR code, the recovery codes, the challenge a sign-in lands on,
and a passkey list with the WebAuthn client to fill it. Every other plugin gives
you a working API and a page you have to build.

`passkey` also comes from its own package — `@better-auth/passkey`, not
`better-auth/plugins` — which is worth knowing before searching the wrong import
for it.

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
Route.get('/dashboard', [DashboardController, 'index']).middleware('auth')
```

| Middleware | What it does |
| --- | --- |
| `auth` | Signed in, or redirected to sign-in |
| `guest` | Signed **out** only — so a signed-in visitor does not see the sign-in form |
| `verified` | Email confirmed |
| `password.confirm` | Re-entered their password recently |
| `can:ability` | Passes an authorization check — see [Authorization](/security/authorization) |

Measured against a scaffolded `jsx` application:

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

Four notifications ship with this package, and the provider fills in better-auth's
mail callbacks with them:

| | when it goes out |
| --- | --- |
| `ResetPasswordNotification` | somebody asked to reset a password |
| `VerifyEmailNotification` | an address needs confirming |
| `PasswordChangedNotification` | a reset completed — a warning, to the account owner |
| `ChangeEmailNotification` | a move to a new address, sent to the **old** one |

They go through `@elvel/notifications` rather than the mailer directly, so they take
the same channels, queue and fake as your own notifications do.

::: tip The stored form carries no token
`toArray()` on the reset notification deliberately omits it. A notification can be
stored by the database channel or written to a log, and a reset token in a log file
is a working key to the account.
:::

### Writing one yourself

```ts
// AppServiceProvider.boot()
import { ResetPasswordNotification } from '@elvel/auth'
import { MailMessage } from '@elvel/notifications'

ResetPasswordNotification.toMailUsing((data) =>
  new MailMessage()
    .subject('Pick a new password')
    .greeting(`Hello ${data.name ?? 'there'}!`)
    .line('Use the button below within the hour.')
    .action('Choose a password', data.url)
)
```

Laravel's `toMailUsing`, and set the same way — once, in a provider at boot. All four
take one.

There is no `createUrlUsing` and that is not an omission: Laravel needs it because
Laravel builds the link, with `route('password.reset')` and
`URL::temporarySignedRoute`. better-auth builds ours and hands it over already
signed, so there is nothing left to override — `data.url` is that link.

### Or take over the whole hook

```ts
// config/auth.ts
emailAndPassword: {
  enabled: true,
  sendResetPassword: async ({ user, url }) => { /* … */ }
}
```

The provider fills these in with `??=`, so a callback you define is left alone. Reach
for this when delivery itself is what you want to change; `toMailUsing` is for when
only the words are.

### They translate

Every sentence goes through the translator when one is registered, the way Laravel's
`Lang::get` does. The English is both the default and the lookup key, so
`lang/id.json` is all it takes:

```json
{
  "Reset password": "Atur ulang kata sandi",
  "This link expires in :time.": "Tautan ini kedaluwarsa dalam :time."
}
```

With no translation registered for a key, the English sends. With no translation
package at all, the same — `@elvel/auth` does not depend on it, and mail has to send
either way.

## Changing an email address

better-auth keeps this behind its own endpoint — `POST /change-email` — because
`updateUser` refuses an `email` outright. With a **verified** address on file the
change waits for a link sent to the *old* inbox; an **unverified** one is
replaced at once, since there is nothing to protect yet and a typo at sign-up
would otherwise be unfixable.
