# Starter kits

::: tip How these compare to Laravel's
Laravel's kits are named by frontend — React, Vue, Svelte, Livewire — and each
ships a component library, teams and two-factor screens. Ours are thinner: `jsx`
is the closest equivalent, with Tailwind, a component set and a dashboard shell;
`auth` is the same pages without Tailwind; `none` and `api` are closer to
variants of one template. Two-factor authentication is here — TOTP with recovery
codes, on by account, in both auth kits. No teams, and no passkeys yet.
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
| `auth` | 82 | 16 | 14 |
| `jsx` | 95 | 16 | 15 |

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

The auth kit's pages, styled with Tailwind. The look is Laravel's own starter
kits: a fixed sidebar with the account menu at the foot of it, breadcrumbs in the
header, settings as a column of pages next to a form, and an appearance setting
with light, dark and system.

```
resources/views/
  components/
    layout.tsx        the document
    auth-layout.tsx   what a signed-out page sits in
    app-shell.tsx     sidebar + header + page, for signed-in pages
    app-sidebar.tsx   nav, footer links, account menu
    app-header.tsx    breadcrumbs, and the nav below `md`
    ui/
      alert.tsx  button.tsx  card.tsx  icon.tsx  input.tsx
      mark.tsx  placeholder-pattern.tsx
  pages/
    welcome.tsx  dashboard.tsx  auth/*  settings/*
resources/js/
    app.ts            the appearance choice, and closing a menu
```

A component set, not a component library. These are the pieces these fifteen
pages actually use, they live in your application, and you edit them — there is
no `npx shadcn add` and nothing to eject from.

Three of them read the request rather than taking props, for the same reason
Laravel's kits reach for a hook:

- `Input` reads `errors()` and `old()`, so a rejected form keeps what was typed
  and says why without the page threading anything through — and a password is
  never repopulated.
- `AppSidebar` reads `user()` for the account menu and the request's own path for
  the active link, so no page has to remember to hand either over.

### Two-factor authentication

On in `config/auth.ts` — `plugins: [twoFactor()]` — and off per account until
somebody turns it on at `/settings/two-factor`. Three pages carry it:

- **Enrolment** shows a QR code rendered on the server with `uqr`, the base32 key
  for typing in by hand, and ten recovery codes. The codes are flashed rather than
  stored, so a reload does not show them again.
- **The challenge**, `/two-factor-challenge`, is where a sign-in lands when the
  account has it on. It is a `guest` route with its own throttle: no session
  exists yet, only better-auth's short-lived `two_factor` cookie.
- **The recovery form**, behind a `<details>` on the same page, posts to its own
  route — a recovery code and a TOTP code are different endpoints, and telling
  them apart by shape is a rule that breaks when either format changes.

Enrolment is deliberately two steps: `enableTwoFactor` hands out a secret and
leaves the account alone, and only a correct code from the app turns it on. A
mistyped setup therefore cannot lock anybody out of their own account.

Whichever kit you use, run the migration after scaffolding — the plugin adds a
`twoFactor` table and a column on `user`:

```bash
bun elvel auth:schema && bun elvel migrate
```

### Colours are roles, not greys

`resources/css/app.css` defines the palette once as tokens — `bg-card`,
`text-muted-foreground`, `border-border`, `bg-sidebar` — in the same oklch values
Laravel's kits use. A page never names a grey, and no component needs a `dark:`
variant for its colours: light and dark are two blocks of variables in that one
file.

The brand red survives in exactly two places, the mark and the focus ring, and
the note in that file explains why its text tint is not the logo's red.

### Dark mode, without the flash

`dark:` compiles to a class here — `@custom-variant dark (&:is(.dark *))` — not to
`prefers-color-scheme`, because "follow the system" is only one of three choices
the appearance page offers. The choice lives in `localStorage`: `resources/js/app.ts`
writes it, and a small **inline** script in `layout.tsx` reads it and sets the
class before the first paint. Inline is the whole trick — a `type="module"`
script is deferred until after the document parses, which is after the browser
has already painted a white page.

So there is no route to submit and nothing stored on the account: a theme is a
fact about this browser, and asking the server for it would cost a round trip and
a white flash on every page load.

### Menus without a component library

The account menu and the small-screen nav are `<details>` elements. That gives
the open state, the keyboard behaviour and the focus handling for free; the two
things it will not do — close on a click elsewhere, close on Escape — are ten
lines in `resources/js/app.ts`. Laravel's kit slides a sheet in instead, which
needs the library, an overlay and focus trapping.

### It is the auth kit, layered

```ts
layers: ['auth', 'jsx']
```

`jsx` carries `resources/`, `vite.config.ts`, and one controller of its own —
`Settings/AppearanceController`, which serves a page that only means anything to a
kit with a stylesheet. Models, factories, the auth config, the tests and every
other controller come from the `auth` layer underneath, and a file this kit ships
replaces the one below it. Copying those thirty-one files instead would have
guaranteed the two drift apart the first time either changed.

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
