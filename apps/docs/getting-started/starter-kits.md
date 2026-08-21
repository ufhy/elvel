# Starter kits

::: tip How these compare to Laravel's
Laravel's kits are named by frontend — React, Vue, Svelte, Livewire — and each
ships a component library, teams and two-factor screens. Ours are thinner: `jsx`
is the closest equivalent, with Tailwind, a component set and a dashboard shell;
`auth` is the same pages without Tailwind; `none` and `api` are closer to
variants of one template. No teams, and no two-factor page — though the
[plugin](/security/authentication#adding-a-better-auth-plugin) that provides
two-factor is two lines away.
:::

A kit is a folder copied **over** the base template, not a fork of it. Everything
a kit does not mention it inherits, so the base and the kits cannot drift the way
two full templates would — Laravel's Breeze installs into an existing application
for the same reason.

Pick one when scaffolding:

```bash
bun create elvel my-app --kit=none
bun create elvel my-app --kit=auth
bun create elvel my-app --kit=jsx
bun create elvel my-app --kit=api
```

## What each one costs you

The numbers below are counted from a real scaffold of each kit, not estimated:

| Kit | Files | Config files | Pages |
| --- | --- | --- | --- |
| `none` | 41 | 9 | 1 |
| `api` | 54 | 15 | 1 |
| `auth` | 76 | 16 | 12 |
| `jsx` | 84 | 16 | 12 |

That difference is the point. `--kit=none` has no mailer, no database, no queue
and no storage, so it has no `config/mail.ts` to wonder about and nothing to
install for a feature it does not use. A kit adds packages *and* the
configuration for them, together, or the configuration would describe something
that is not there.

## `none` — a landing page

The base template and nothing else: one controller, a welcome page, a health
endpoint, sessions, CSRF, views and Vite. No database. This is the honest
starting point for something whose shape you do not know yet.

## `jsx` — the one with Tailwind

The auth kit's pages, styled with Tailwind, plus a component set and a dashboard
shell:

```
resources/views/
  components/
    layout.tsx        the document
    auth-layout.tsx   what a signed-out page sits in
    app-shell.tsx     sidebar + header, for signed-in pages
    ui/
      alert.tsx  button.tsx  card.tsx  input.tsx  mark.tsx
  pages/
    welcome.tsx  dashboard.tsx  auth/*  settings/*
```

Five components, not a library. They are the pieces these twelve pages actually
use, they live in your application, and you edit them.

`Input` is the one worth looking at: it reads `errors()` and `old()` itself, so a
rejected form keeps what was typed and shows why without the page threading
anything through — and a password is never repopulated.

### It is the auth kit, layered

```ts
layers: ['auth', 'jsx']
```

`jsx` carries only `resources/` and `vite.config.ts`. Controllers, models,
factories, the auth config and the tests all come from the `auth` layer
underneath, and a file this kit ships replaces the one below it. Copying those
thirty-one files instead would have guaranteed the two drift apart the first time
either changed.

### Tailwind

v4, through its own Vite plugin. There is **no `tailwind.config.js`**: it
configures itself from CSS, and finds class names by scanning every text file in
the project — `.tsx` included, since it reads them as text rather than parsing
them. So there is no content list to keep in step with where your views live.

The brand colours are `@theme` tokens in `resources/css/app.css`, and the note
there explains why the text tint is not the logo's red.

::: warning Inside a monorepo, pin what Tailwind scans
Tailwind skips anything `.gitignore` covers and otherwise scans from the project
root — which for an application inside a larger repository is the wrong answer in
both directions at once: its own views can be invisible, and everything else in
the repository is not.

Measured on the same application, built inside the Elvel checkout and outside it:

| | stylesheet | build |
| --- | --- | --- |
| outside a repository | 19.9 kB | 0.4 s |
| inside, scanning from the root | 54.6 kB | 10.8 s |
| inside, with the sources named | 19.9 kB | 0.13 s |

Naming them is two lines:

```css
@import "tailwindcss" source(none);
@source "../views";
@source "../../app";
```

`source(none)` turns automatic detection off, and each `@source` is relative to
the stylesheet. Outside a repository — which is every real application — the
default is right and there is nothing to do.
:::

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
