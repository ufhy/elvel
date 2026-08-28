# Starter kits

::: tip How these compare to Laravel's
Laravel's kits are named by frontend — React, Vue, Svelte, Livewire — and each
ships a component library, teams and two-factor screens. Ours are thinner: `jsx`
is the closest equivalent, with Tailwind, a component set and a dashboard shell;
`auth` is the same pages without Tailwind; `vue` is a single-page application with
**shadcn-vue**, a collapsible sidebar and a JSON API behind it; `none` and `api` are
closer to variants of one template. Two-factor authentication and passkeys are in
all three auth kits. No teams.

One difference worth knowing before you pick: Laravel's Vue kit renders every page
through Inertia, which sends a page's props with each navigation. Ours does not
send props at all — the document is a shell and each screen reads what it needs
from `/api/`. Closer to `Route::view('{path}', 'main')` with an API behind it than
to Inertia.
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
bun create elvel my-app --kit=vue
bun create elvel my-app --kit=api
```

## What each one costs you

The numbers below are counted from a real scaffold of each kit, not estimated:

| Kit | Files | Config files | Pages |
| --- | --- | --- | --- |
| `none` | 42 | 10 | 1 |
| `api` | 55 | 16 | 1 |
| `auth` | 87 | 17 | 15 |
| `jsx` | 100 | 17 | 16 |
| `vue` | 235 | 18 | 15 Vue + 12 stubs + `welcome.tsx` |

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

A component set, not a component library. These are the pieces these sixteen
pages actually use, they live in your application, and you edit them — there is
nothing to eject from. Nor is there a CLI to add the twentieth: this set is
hand-written for these pages, which is the trade against the `vue` kit's
shadcn-vue, where `bunx shadcn-vue add dialog` writes a new component for you and
ninety files arrive whether you touch them or not.

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

### Passkeys

A fingerprint, a face or a screen lock instead of a password, over WebAuthn. The
plugin is `@better-auth/passkey`, enabled beside `twoFactor()` in
`config/auth.ts`, and it adds a `passkey` table — so the same
`auth:schema && migrate` covers both.

This is the one feature in the kit that **needs JavaScript**, and only for two of
its four parts:

| | where it runs |
| --- | --- |
| register a passkey | the browser — `navigator.credentials` creates the key |
| sign in with one | the browser — the device signs a challenge |
| list them | the server, rendered into the page |
| remove one | the server, an ordinary `DELETE` form |

`resources/js/passkeys.ts` is the whole client side: one `createAuthClient`, two
delegated click handlers, and the conditional-UI call. It is imported by
`resources/js/app.ts` in both auth kits — the same file, unchanged, because
nothing in it is about styling.

The sign-in field carries `autocomplete="username webauthn"`, which is what lets
the browser offer a passkey from the address field itself rather than only from
the button. In testing against a virtual authenticator that path was so quick it
beat a scripted click to the button.

::: warning WebAuthn needs a real origin
A credential is bound to the domain that created it. `rpID` defaults to the host
and the origin comes from `baseURL`, so **`APP_URL` must be your real origin over
https** in production. Plain http works on `localhost` and nowhere else, and a
mismatch fails as a browser prompt that closes without saying why.
:::

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
configures itself from CSS, and finds class names by scanning every text file it is
pointed at — `.tsx` included, since it reads them as text rather than parsing them.
So there is no content list to keep in step with where your views live, only a
directory to point at.

The brand colours are `@theme` tokens in `resources/css/app.css`, and the note
there explains why the text tint is not the logo's red.

::: tip Where Tailwind looks is pinned, and it is worth knowing why
Both kits ship it, so there is nothing for you to add:

```css
/* jsx: resources/css/app.css */    @import "tailwindcss" source("../");
/* vue: frontend/src/style.css */   @import "tailwindcss" source("./");
```

Left to decide for itself, Tailwind reaches outside the application. Measured on a
fresh scaffold of each kit, cold, in this repository:

| | `bun run dev` to first stylesheet | `bun run build` | stylesheet |
| --- | --- | --- | --- |
| `jsx`, unpinned | 108.7 s | 40.8 s | 59.6 kB |
| `jsx`, pinned | **1.7 s** | **0.9 s** | 24.9 kB |
| `vue`, unpinned | 14.3 s | 8.4 s | 108.1 kB |
| `vue`, pinned | **3.1 s** | **1.7 s** | 66.6 kB |

The smaller stylesheets lose nothing: the 478 utilities dropped from `jsx` were
checked one by one against its own `resources/`, and not one is used. They were
there because other projects in the same folder tree mentioned them.

**These are a worst case.** An application scaffolded inside this repository has
demos and kit templates for neighbours; yours has fewer, and would be faster even
unpinned. Pinning is still right, because it makes the stylesheet depend on your
application alone rather than on whatever sits beside it.

If classes ever live somewhere else, name it — each `@source` is relative to the
stylesheet:

```css
@source "../../packages/ui";
```

An earlier version of this page said Tailwind skips whatever `.gitignore` covers,
so an application inside a checkout would find its own views invisible. Measured,
that is not what happens: the views were found, and so was everything else.
:::

## `vue` — a single-page application, on the auth kit

The auth kit, with everything in front of it written in Vue:

```
my-app/
├── app/, routes/, config/     the application
├── resources/views/           the document, and the landing page
└── frontend/                  a `bun create vite` project
    ├── package.json           vue, vue-router, vite — its own
    ├── components.json        so `bunx shadcn-vue add …` works here
    ├── vite.config.ts         `vue()`, `tailwindcss()` and `elvel()`
    └── src/
        ├── main.ts            the application — boots by asking who you are
        ├── auth.ts            the seven auth screens, a bundle of their own
        ├── api.ts             every read this client makes
        ├── style.css          Tailwind v4 + the shadcn theme, in oklch
        ├── components/ui/     90 files, written by `shadcn-vue init`
        ├── routers/           app.ts and auth.ts — one per bundle
        ├── layouts/           App (sidebar), Auth (one card), Settings
        ├── composables/       usePasskey, useAppearance, useResource
        ├── lib/form.ts        useForm, wired to this application's two answers
        └── views/             the pages the routers own
```

Those 90 files are what shadcn is: components live **in** your project, not behind
a version number, so changing one is editing a file. `components.json` is what
makes the CLI keep working — `bunx shadcn-vue add dialog` writes beside them and
matches their style.

::: warning The client project pins classic TypeScript
`typescript@5` and `vue-tsc`, not the framework's TypeScript 7 — and it is not a
preference. `defineProps<SidebarProps>()` extends a type imported from `reka-ui`,
and to read it the SFC compiler needs TypeScript's own module resolution: *"
TypeScript is required as a peer dep for vue in order to support resolving types
from module imports."* TypeScript 7 is a native binary no JavaScript runtime can
import, so `ts.sys` comes back empty and the build fails once per component with
typed props. It buys something back: `vue-tsc` runs, so props are checked across a
`.vue` boundary.
:::

`frontend/` is an ordinary Vite project. Every Vite tutorial, upgrade guide and
plugin applies to it verbatim, because there is nothing framework-specific in it
beyond one plugin. Swapping Vue for something else is swapping that directory.

One `bun install` covers both: the application's manifest names `frontend` in its
`workspaces`, so its dependencies land in a `node_modules` of its own rather than
resolving by accident through the application's.

### Every screen is Vue, and the document carries nothing

Every screen in this kit is a `.vue` file — the seven auth ones and the six
settings ones included. A kit whose name is Vue should not hand you fourteen `.tsx`
pages to learn a second view layer for.

And the document they boot from is a **shell**: 327 bytes, no payload, and
`cache-control: public, max-age=0, must-revalidate`. The same bytes for everybody, which
is what a cache can keep. Everything a screen needs it asks for:

```
GET /api/session               who is asking, and this session's CSRF token
GET /api/settings/profile      the name and address the form edits
GET /api/settings/sessions     every browser this account is signed in on
GET /api/settings/passkeys     the credentials registered here
GET /api/settings/two-factor   whether it is on, and any enrolment in progress
```

That is the difference between this and a server-driven application, and it is not
a preference — it is what makes client-side navigation correct. A payload embedded
in a document belongs to *that document*, so a client navigation arrives carrying
the previous page's data. Measured, before this kit was rebuilt: pushing to
`/dashboard` after signing in rendered a shell with `user: null` — no user menu, no
way to sign out — and a CSRF token `regenerate()` had already invalidated.

A request belongs to the page that made it, so navigation is free:

```js
// measured in the browser, after four navigations
{ url: '/settings/profile', documentsLoaded: 1, title: 'Profile' }
```

### Two bundles, and one route each

```ts
// routes/view.ts — the whole server side of the client
Route.prefix('auth').middleware('guest').group(() => {
  Route.view('/{path}', Shell, { entry: 'src/auth.ts' }).where('path', '.*')
})

Route.middleware('auth').group(() => {
  Route.view('/{path}', Shell, { entry: 'src/main.ts' }).where('path', '.*')
})
```

Two routes, because one cannot carry both guards — `guest` turns somebody already
signed in away from the sign-in screen, and `auth` sends a stranger to it. The entry
is the only prop that differs: a guest downloads seven forms and not the application
behind them.

**The page list lives in one place, and that place is the client.**
`frontend/src/routers/` knows the addresses; the server knows two wildcards. Adding
a screen is one file and one router line, with nothing to add on the server and
nothing to keep in step.

Everything else a document carries is markup in `resources/views/components/shell.tsx`
— the title, the icon, the mount point. A route hands it no strings of HTML.

::: warning What guards a client-routed address
The prefix, not the address. Everything under `/auth/*` is behind `guest` and
everything else is behind `auth`, so a guest reaching for `/dashboard/reports` is
redirected before a byte of the application is served — which is stronger than the
kit's earlier shape, where an address only the Vue router knew answered `200`.

What is still true: the client's own router guard is not what protects data. Every
endpoint under `/api` carries its own, because that is where the data is. Guarding
the page alone guards the door and leaves the window.
:::

### Without changing the `auth` kit it is built on

That constraint shaped the design. This kit ships the **actions** and nothing else:
`routes/auth.ts` and `routes/settings.ts` are the auth kit's route files with every
`GET` page route removed, and the controllers behind them are action-only — no
`.tsx` page is imported and none is rendered.

```ts
// routes/auth.ts — the actions, and no pages
Route.post('/sign-in', [SignInController, 'store'])
Route.post('/sign-up', [RegisterController, 'store'])
…
```

Nothing shadows anything, which is the difference from how this kit began. A page
route that a later registration takes over is a page route that still has to exist,
still imports a `.tsx` file, and still has its guards and its refusals written twice
— `GET /reset-password` without a token has to redirect whichever handler answers.
Removing the routes instead removes all of that: the pages are gone, the twelve
`.tsx` files they imported are gone with them, and every guard is written once.

What it costs is a copy. These route files and controllers are this kit's own rather
than the auth kit's, so a change to an auth action has two files to land in. That is
the trade for a kit whose Vue half is the only half.

### What a form does

**Refused: nothing reloads.** The server answers a client `422 { errors }` instead
of a redirect, and `useForm` puts each message under its own input with what was
typed still there.

**Succeeded: it depends where it leads.** A settings form asks its page to read
again — the answer changed the thing on screen. Signing in loads a document,
because it crosses into the other bundle *and* rotates the session id, which
changes the CSRF token with it.

**Locked: a dialog, and the request is retried.** `password.confirm` answers a
client `423`, and `confirmed()` opens the password wall in place, then runs the same
request again once it is answered — so nothing is lost and nobody leaves the screen.
Reloading the document was the first version and could not work here: one view route
answers every address, including the confirmation screen, so the reload was a loop —
same shell, same request, same 423. Measured, the two-factor screen reloaded
forever.

::: tip One Vite project, three entries
`frontend/vite.config.ts` builds `src/main.ts` (the application), `src/auth.ts`
(the auth screens) and `src/server.ts` (the stylesheet for `welcome.tsx`, the only
page the server renders). One project, one manifest, one build, so there is never a
question of which of three configs wrote what.

A stylesheet two entries share lands in a chunk they share, and `vite()` walks the
import graph to find it — without that the page rendered unstyled with nothing in
the console, which is how this was found.
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

After changing `config/auth.ts`, ask for the difference — `auth:schema` on its own
writes a full `create`, which an application that has already migrated cannot run:

```bash
bun elvel auth:schema --diff
bun elvel migrate
```
