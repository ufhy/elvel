# Views

A view is a TypeScript function that returns markup. There is no template engine,
no view path to configure, and no compile cache — Bun's module cache *is* the
compile cache, and `tsc` is the template checker.

```tsx
// resources/views/pages/welcome.tsx
export function Welcome({ title }: { title: string }) {
  return (
    <Layout title={title}>
      <h1>{title}</h1>
    </Layout>
  )
}
```

```ts
import { view } from '@elvel/view'

// routes/web.ts
Route.get('/', () => view(Welcome, { title: 'Welcome' }))
```

The component is passed **by reference, not by name**. A renamed prop or a
missing one is a compile error rather than a blank page — which is the one thing
a string-keyed template system can never give you.

`render(Component, props)` returns the HTML as a string instead, for embedding in
an email or asserting in a test. `<!DOCTYPE html>` is prepended automatically
when the markup starts with `<html`, because JSX has no doctype node.

## Escaping is opt-in, and this matters

`@kitajs/html` does **not** escape interpolated values. Mark them `safe`:

```tsx
<p safe>{note}</p>   {/* escaped */}
<p>{note}</p>        {/* raw — the value is trusted markup */}
```

Rendered with `note = '<script>alert(1)</script>'`, that is exactly what it
sounds like:

```html
<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>
<p><script>alert(1)</script></p>
```

The second line is a working XSS. The rule is short: **anything that came from a
person gets `safe`**, and the only values that go without it are markup your own
code produced.

**Attributes are not the same, and the asymmetry is the trap.** An attribute value
*is* escaped without asking — measured:

```tsx
<input value={'" autofocus onfocus="alert(1)'} />
→ <input value="&#34; autofocus onfocus=&#34;alert(1)"/>
```

So `value={old('name')}` is safe and `<p>{old('name')}</p>` is not, which is exactly
the wrong lesson to learn by experiment. Escaping an attribute twice is harmless, so
when in doubt write `safe` — the cost of a habit is nothing and the cost of the
exception is a working XSS.

This matters most in a component somebody else calls. Every label the kits pass is a
literal, but a reusable `<Input label={…} />` renders whatever it is given, so its
own markup carries `safe` rather than trusting each caller to remember.

::: warning A scanner exists, but it is not a compile-time check
`@kitajs/ts-html-plugin` finds missing `safe`, and it cannot run *as an editor
plugin* here: a TypeScript language-service plugin is loaded by the TypeScript the
project uses, and its CLI reads `typescript.sys`, which TypeScript 7 removed from
the default export. So it crashes on this framework's own TypeScript, under both
Bun and Node.

Its **CLI** does run, pinned to TypeScript 5 in a workspace of its own. This
repository does exactly that — `tools/xss-scan`, invoked with `bun run xss:scan` —
and it is worth copying into an application:

```jsonc
// tools/xss-scan/package.json — nothing but the pinned toolchain
{ "devDependencies": { "@kitajs/ts-html-plugin": "^4.1.4", "typescript": "~5.9.3" } }
```

Read the output knowing what it cannot know. It treats **every string** as suspect
and has no way to be told otherwise — no branded type helps, and there is no ignore
comment; only an expression whose text begins with `safe` or `escapeHtml` is
accepted. So every helper that returns trusted markup is reported: on this
repository, 79 findings of which 75 are `csrfField()`, `vite()`, `stack()` and their
like. That is why it is a script somebody runs and reads rather than a gate that
blocks a merge.

The four that were not are what it is for. One of them was a real XSS no reading of
these files had caught, because the flaw was inside a template literal inside a
callback rather than at an interpolation. `safe` remains a runtime guarantee and a
review responsibility; this shortens the review.
:::

## Layouts

A layout is a component that takes `children`. There is no `@extends`, because
nesting says it already:

```tsx
export function Layout({ title, children }: { title: string; children?: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <title safe>{title}</title>
        {vite('resources/css/app.css')}
      </head>
      <body>{children}</body>
    </html>
  )
}
```

## Stacks — what a page contributes to a layout

A layout renders its `<head>` before it renders `children`, so a page that wants
a stylesheet in the head is already too late by the time it runs. Blade gets away
with `@push` because `@extends` renders the child first; JSX nests the other way
round and cannot.

```tsx
import { prepend, push, pushOnce, stack } from '@elvel/view'

function Layout({ children }) {
  return <html><head>{stack('head')}</head><body>{children}</body></html>
}

function Item({ n }) {
  pushOnce('head', 'item-css', '<link rel="stylesheet" href="/item.css">')
  push('head', `<!-- item ${n} last -->`)
  prepend('head', `<!-- item ${n} first -->`)

  return <li>{n}</li>
}
```

Two items produce one stylesheet, prepends in reverse and pushes in order —
Blade's ordering, and the one that makes "prepend" mean anything:

```html
<head>
  <!-- item 2 first --><!-- item 1 first -->
  <link rel="stylesheet" href="/item.css">
  <!-- item 1 last --><!-- item 2 last -->
</head>
```

`stack()` writes a marker that the factory substitutes once the whole tree has
rendered. The marker carries a per-render random id, so a value from a form that
happens to contain the marker text cannot be replaced with somebody else's
scripts. `once(id, markup)` returns the markup the first time it is called in a render
and an empty string after that — `pushOnce` without a stack, for markup that
belongs where the component is rather than in the head.

## Attribute helpers

Three, and only three — the Blade directives JSX has no answer for. `@if` is a
ternary, `@foreach` is `.map()`, `@include` is a component, `@checked` is
`checked={…}`.

```tsx
classes('card', { wide: isWide, hidden: false })   // "card wide"
styles('color: red', { 'font-weight: bold': bold }) // "color: red; font-weight: bold;"
```

Note the shape: an object's **keys are the class names or the whole CSS
declarations**, and its values are the conditions. That is Blade's `@class` and
`@style`, not React's style object — `styles({ color: 'red' })` means "include
the declaration `color` if `'red'` is truthy" and produces `color;`. Arrays are
not accepted at all, and TypeScript says so:

```
Argument of type 'string[]' is not assignable to parameter of type 'ClassInput'.
```

### `json()` — the one with teeth

```tsx
<script>{`window.__STATE__ = ${json(state)}`}</script>
```

Inside a `<script>` the HTML parser is looking for the literal characters
`</script`, so a value containing one **ends the block early** and everything
after it is markup again. `{"bio": "</script><img onerror=…>"}` is a working XSS
through a field that never touched the HTML escaper, because `JSON.stringify` has
no reason to care.

```
json({ user: '</script><b>x</b>' })
→ {"user":"\u003c/script\u003e\u003cb\u003ex\u003c/b\u003e"}
```

The escaped set is Laravel's `@json`: `<` `>` `&` `'` `"`. The quotes are what
make the result safe in an **attribute** too, so
`<button data-user={json(user)}>` needs no second helper. U+2028 and U+2029 are
escaped as well — they are valid in JSON strings and are line terminators in
JavaScript, so leaving them alone turns ordinary-looking text into a syntax error
in the page.

## Streaming a slow page

`view()` renders the whole page before it answers, so a page whose slowest query
takes two seconds shows nothing for two seconds — no title, no layout, no
spinner.

```ts
import { stream } from '@elvel/view'

.get('/dashboard', () => stream([
  [Shell, { title: 'Dashboard' }],
  [SlowStats, { userId }],
  [Footer, {}]
]))
```

Each part renders in order and is sent as it comes. A part that throws does not
take the response with it — the status was sent long ago — so it becomes an HTML
comment naming the failure and is reported. The response also carries
`cache-control: no-transform` and `x-accel-buffering: no`, because a proxy that
buffers undoes the whole thing.

## Live reload

`bun run dev` reloads the browser when you edit a view. It is worth knowing what
does what, because three separate things are involved and only one of them is
ours.

```bash
bun run dev        # server (bun --hot) + Vite + queue + scheduler, one terminal
```

1. **`bun --hot` reloads the server.** It re-evaluates the module graph in place
   rather than restarting the process, so the next request renders the new markup.
   Measured on a scaffolded application: a view change reaches the next request in
   **72ms**, and five successive edits each landed. `--watch`, the alternative,
   restarts the process and took 2676ms.

   This works only because `serve` returns once it is listening. Bun will not
   re-evaluate a graph whose entry point is still evaluating, and `serve` used to
   end in a promise nobody resolved — so `--hot` did nothing at all, silently, and
   every edit needed a restart. See `Command.holdsProcess`.
2. **A Vite plugin tells the browser.** `vite.config.ts` watches
   `resources/views`, `app`, `routes` and `config`, and pushes
   `{ type: 'full-reload' }` down the socket `@vite/client` already holds.
3. **`resources/js` and `resources/css` keep real HMR**, because those *are*
   modules in the browser and Vite can swap them.

::: warning A view gets a full reload, not a hot update — and it cannot get one
A `.tsx` view is rendered to a **string on the server**; the browser never
receives a module for it, so there is nothing to swap. State-preserving HMR is
not a missing feature here, it is a question that does not apply — the same
reason Laravel has never had HMR for Blade. Fetching the page again is the honest
answer, and it is what `laravel-vite-plugin`'s `refresh` option does too.
:::

### Neither Bun nor Elysia provides this

Worth stating, because it is the first place anybody looks:

- **Bun** has `--watch` (hard restart) and `--hot` (soft reload). Its
  documentation says outright that `--hot` "is not the same as hot reloading in
  the browser" and points at Vite for that. Bun's full-stack dev server *does*
  have browser HMR, but scoped to client-side bundles reached through HTML
  imports — not to server-rendered HTML responses.
- **Elysia** offers nothing here; its quick start only notes that a dev command
  reloads the *server* on file changes.

Neither is in a position to: whatever reloads the page has to hold a socket to
the page. Bun holds the process, Elysia holds the routes, and Vite holds the
socket.

Without Vite installed, `dev` says so rather than leaving you guessing:

```
vite is not installed, so assets and browser reload are off.
```

`--no-assets` turns it off deliberately.

## Assets

```tsx
{vite('resources/js/app.ts')}
{vite(['resources/css/app.css', 'resources/js/app.ts'])}
```

Two modes. In **development** the Vite dev server writes a hot file, and the tags
point at that server, so a stylesheet change reaches the browser without a
rebuild. In **production** the tags come from `manifest.json`, which maps the
entry point to the hashed filename the build produced.

The hashing is what earns it its place: without a manifest an application either
serves `app.js` for ever — and a deploy ships stale JavaScript to anybody with a
warm cache — or defeats caching entirely with a query string.

When there is neither a dev server nor a build, it **throws in production** and
stays quiet elsewhere. Laravel throws in every environment; here a missing build
in production means a deploy shipped an unstyled page and silence would be wrong,
while locally it usually means `bun run build` has not been run yet.

### One plugin, and what it settles

```ts
// vite.config.ts
import elvel from '@elvel/vite'

export default { plugins: [elvel({ input: 'resources/js/app.ts' })] }
```

`@elvel/vite` answers what an application should not have to decide, and every
value defers to one the application sets itself:

| | why it is not a default worth rediscovering |
| --- | --- |
| the hot file | its presence is how the server knows to point at Vite, and it has to be removed when Vite stops |
| a full reload on view changes | a `.tsx` view is a string on the server, so there is no module to swap |
| `base` per command | `/build/` in a build, empty in `serve`, where `base` is also the path the dev server answers under |
| `publicDir: false` | the build output lives *inside* `public/`, so the copy step would walk the directory it writes into |
| `manifest.json` | Vite 5 moved it to `.vite/manifest.json`; this puts it back where the server looks |
| `outDir` | `public/build` **of the application**, found by walking up for `elvel.ts` |

That last row is what makes a decoupled client work. `laravel-vite-plugin` exists
for the same reason and settles the same questions; five hand-written copies of
this logic lived in this repository first, and the drift between them is where the
bugs were — an unset `base` made a lazily imported chunk 404 in one of them while
the others were fine.

### What the other Vite plugins inject

A Vite plugin puts things in the page through `transformIndexHtml`, and that hook
needs an `index.html` to transform. A document rendered by the server is not one —
so those injections used to be lost. Measured against the official Vite templates:

| plugin | what was missing | what broke |
| --- | --- | --- |
| `@vitejs/plugin-react` | the `/@react-refresh` preamble | Fast Refresh, silently — the page still worked |
| `vite-plugin-vue-devtools` | `overlay.js`, `load.js` | DevTools never loaded |

`@elvel/vite` asks Vite for them when the dev server starts and writes them beside
the hot file; `vite()` renders them between the client and your entry, **and adds
the request's CSP nonce to any of them that is inline**. React's preamble is inline,
and the plugin that wrote it could not have known the nonce — it renders its tag at
the dev-server handshake, long before the request that carries one. Without that, a
policy this framework sends itself would refuse the preamble and Fast Refresh would
quietly become a full reload. That order
is the requirement: React's preamble installs a global hook its components register
against as they evaluate, so after the entry it is too late.

Nothing in the framework knows what either of those plugins is, and a plugin nobody
has written yet arrives the same way.

During a build there is no dev server to ask, and the hook only runs for an HTML
input — so the plugin builds the project's own `index.html` for its side effect,
harvests what the plugins put in it, and then drops the page from the output. The
tags land beside the manifest and `vite()` renders them after your entry.

That is what makes `vite-plugin-pwa` work with nothing added to the framework:

```
<link rel="manifest" href="/build/manifest.webmanifest">
<script id="vite-plugin-pwa:register-sw" src="/build/registerSW.js"></script>
```

Told apart from the page's own tags by what each tag *is* — its name, and its
`rel`, `id` or `type` — because a build rewrites URLs, so the template's own
`favicon.svg` comes back looking different from the one on disk. What Vite adds for
an HTML entry is dropped as well: a stylesheet and a `modulepreload` both name the
chunk the view already renders.

::: tip The document is still yours
The built `index.html` is never published, and its key is removed from the manifest.
A second document in the output would answer `/build/index.html` with a stale copy
of a shell nobody serves.
:::

### An SSR build writes outside the web root

```bash
bun x vite build --ssr src/entry-server.ts
```

`bootstrap/ssr/entry-server.js`, and `ssrDirectory` moves it. It has to be outside
`public/`: measured before this existed, the server bundle landed in
`public/build/entry-server.js` — downloadable at `/build/entry-server.js` — and its
manifest overwrote the client's, so every page then threw `is not in the Vite
manifest`.

### When the client is its own project

`config/vite.ts` names the directory the client lives in:

```ts
// config/vite.ts
export default {
  // `.` is the scaffold: vite.config.ts beside elvel.ts, client source in resources/.
  projectDirectory: 'frontend',
  buildDirectory: 'build',
  assetsDirectory: 'assets'
}
```

`assetsDirectory` is Vite's `build.assetsDir`, and it is the key that decides what
gets cached for a year. Only files there carry a content hash and therefore cannot
go stale; what sits at the build *root* keeps its name when its contents change —
`manifest.json`, and whatever a plugin emits beside it. Measured before this key
existed, with the whole build directory treated as hashed: a `vite-plugin-pwa`
service worker went out `max-age=31536000, immutable` under a name with no hash in
it, so a browser had no reason to fetch the next one for a year. The application
would have frozen at its first deployed worker with nothing failing anywhere.

Change it here and in `vite.config.ts` together, as with `buildDirectory` — two
halves of one decision.

`elvel dev` runs Vite there. That is what a decoupled front end needs — `bun create
vite` in `frontend/`, kept standard, with its own config and `node_modules` — and
the default of `.` is the scaffold, where nothing has to change. Its config is a
standard one plus the plugin:

```ts
// frontend/vite.config.ts
import vue from '@vitejs/plugin-vue'
import elvel from '@elvel/vite'

export default { plugins: [vue(), elvel({ input: 'src/main.ts' })] }
```

Nothing there names the application's directory. The plugin finds it by walking up
for `elvel.ts`, so the hot file and the build output land in the application while
the client project stays a client project.

::: warning Pointed at the wrong directory, Vite still starts
It takes a port and answers **404 for every path**, and it writes no hot file — so
the server falls back to `manifest.json` and serves the last build while `dev`
reports that assets are up. Measured before this setting existed. If the browser
is showing yesterday's JavaScript in development, this is the first thing to check.
:::

## Static files

The provider answers files under `public/` itself and mounts `@elysiajs/static`
behind it for what it does not: a range request. Turn it off with
`view.serveStatic: false` when something in front of the application already
serves them.

**A path with no file on disk belongs to the router.** That is Laravel's shape —
nginx `try_files $uri $uri/ /index.php`, Valet `file_exists(...) ? path : false` —
and it is what makes `.get('/*')` work, in development exactly as in production.
The plugin is mounted with `alwaysStatic: true` for it: a route per file that
exists, never a `/*` that answers its own misses. With `false` it claimed that
path in development only, and an application whose catch-all was `.get('/*')`
served `/deep/link` in production and 404 locally, from one source.

The reason `false` was there — an asset added while the server runs — costs
nothing now: the provider's own handler stats the path per request, so a file
written after boot is served without a restart.

Answering them here is what makes two things possible. A served file carries the
[security headers](/security/headers) — the static plugin's routes skip the
surrounding lifecycle, so nothing else can give them to it. And it revalidates:
`@elysiajs/static` sets an `ETag` and ignores `If-None-Match`, measured as a 200
with all 81,048 bytes for a request asking whether anything had changed. A path
with no extension is never stat'd, so an address the client router owns costs
nothing here.

### Compression

Compressible files — `.js`, `.css`, `.svg`, `.json`, `.map` and friends — are
served gzipped to any caller that accepts it. Measured on a built application, a
page went from 182 kB on the wire to 68 kB, and its largest script from 44.6 kB
to 15.4 kB.

This matters more than it sounds: `@elysiajs/static` answers with the bytes on
disk and ignores `accept-encoding`, so before this an application shipped every
asset uncompressed unless something in front of it stepped in.

In production the compressed bytes are kept in memory, keyed by the file's size
and modification time, so a file is compressed once rather than per request —
measured at no change in throughput. In development nothing is cached, because a
file changes under a name that does not.

Two things it deliberately does not do. It never compresses a **rendered page**,
only files: a response that mixes a secret with something the caller controls is
what makes compressing dynamic HTML a subtle question, and the measured waste was
all in the assets anyway. And it never compresses a file that comes out no
smaller — a `.png`, or anything below `view.compressMinimumBytes` (1 kB), where
gzip's own framing can make the response bigger.

```ts
// config/view.ts
export default {
  compressStatic: true,
  compressMinimumBytes: 1024
}
```

Set `compressStatic: false` when nginx, a CDN or a platform router already
compresses. Compressing twice is wasted work.
