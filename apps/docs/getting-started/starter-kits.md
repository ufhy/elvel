# Starter kits

A kit is a folder copied **over** the base template, not a fork of it. Everything
a kit does not mention it inherits, so the base and the kits cannot drift the way
two full templates would — Laravel's Breeze installs into an existing application
for the same reason.

Pick one when scaffolding:

```bash
bun create elvel my-app --kit=none
bun create elvel my-app --kit=auth
bun create elvel my-app --kit=api
```

## What each one costs you

The numbers below are counted from a real scaffold of each kit, not estimated:

| Kit | `@elvel/*` packages | Config files | Controllers |
| --- | --- | --- | --- |
| `none` | 12 | 9 | `PageController` |
| `api` | 18 | 15 | `PageController`, `ApiAuthController` |
| `auth` | 19 | 16 | `PageController`, `DashboardController`, `Auth/*`, `Settings/*` |

That difference is the point. `--kit=none` has no mailer, no database, no queue
and no storage, so it has no `config/mail.ts` to wonder about and nothing to
install for a feature it does not use. A kit adds packages *and* the
configuration for them, together, or the configuration would describe something
that is not there.

## `none` — a landing page

The base template and nothing else: one controller, a welcome page, a health
endpoint, sessions, CSRF, views and Vite. No database. This is the honest
starting point for something whose shape you do not know yet.

## `auth` — sign in, sign up, a dashboard

Server-rendered authentication over [better-auth](https://better-auth.com):
sign-in, sign-up, password reset, password confirmation, email verification, a
dashboard, and profile and password settings. Five controllers rather than one,
split by what a page is *for* — they were one file of 619 lines and nineteen
routes, which is not a thing anybody wants to inherit.

Nothing here is a black box you have to eject from: every page is a `.tsx` file
in your application, and every route is in a controller you can read.

## `api` — a token, not a cookie

Identity is better-auth's session token, handed out through the `bearer` plugin's
`set-auth-token` header and sent back as `Authorization: Bearer …`. There is no
second identity table and no second notion of a session; a personal-access-token
store — Sanctum's shape — is a different feature this kit deliberately does not
invent.

It has no auth *pages*: one welcome view and its layout, and every other route
answers JSON. Views and Vite are still configured, because the welcome page is a
page.

## Both auth kits leave the tables to you

Neither ships a migration for the users table, and that is deliberate: **what the
tables are depends on `config/auth.ts`** — the options and plugins you enable
decide the columns. So the schema is generated rather than shipped:

```bash
bun elvel auth:schema
bun elvel migrate
```

Run `auth:schema` again after changing `config/auth.ts`, and it writes a
migration for the difference rather than the whole table.
