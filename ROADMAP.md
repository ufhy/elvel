# What is next

The fourth list `BEHAVIOURS.md` said would only be written when there was real
work to count again. This is it.

Every row here is something not built yet. A row is **deleted** when it is done —
never narrowed, never rewritten smaller — because a list that cannot shrink says
nothing about progress. Where a row rests on a measurement, the measurement is in
it: a number is the only part of a plan that can be wrong in a way somebody
notices.

Rows marked **decision** are not work. They are questions whose answer changes
the shape of the work, and they belong to whoever owns the framework, not to
whoever picks up the task.

---

## `@elvel/islands`

A server-rendered page with client components mounted into it, framework-neutral
by construction.

The contract is two attributes, and neither says "Vue":

```html
<div data-island="MemberTable" data-props="{&#34;rows&#34;:[…]}"></div>
```

Measured in a demo built on this shape (`.demo/island-demo`, outside git):

| | measured |
| --- | --- |
| a page with no island | `app.js` + the island entry — **no framework runtime at all** |
| the island entry itself | 1,761 B raw, ≈1 kB gzip |
| Vue's runtime, on pages that mount something | 62,914 B raw, 24,787 B gzip |
| one island's own chunk | `MemberTable` 1,160 B, a second island 340 B |
| two islands on one page | two chunks, one shared runtime |

So the cost is proportional to what a page actually uses, which is the whole
argument. A form page pays nothing.

What the package owes an application:

- the client runtime — the mount loop, and a registry built with
  `import.meta.glob` rather than a hand-written list. A list is a file to edit for
  every island somebody adds, and forgetting the edit is invisible: the component
  exists, the `<div>` renders, nothing mounts.
- a server-side `<Island name props>` that writes those attributes and **escapes**
  the props. `json()` already does the escaping; a quote inside a name closes the
  attribute and turns the rest of the document into markup somebody else wrote.
- the Vite wiring, so an application does not assemble it by hand.
- a named island that does not exist must say so. With a list it was a `keyof`
  error at compile time; resolved by convention it happens at run time, and a
  silent skip means an empty box for reasons nothing explains.

### decision: does an island render content, or add behaviour?

The demo answered this wrongly and measured the consequence. With scripting off,
its members page carried **178 characters**; the whole-page Vue demo carried
**2,214** and all fifty rows.

The rows existed only inside `data-props`, so the island owned the content — and
an island that owns its content is not an island. The name is the argument: a
piece surrounded by a sea of server-rendered HTML. Remove the sea and it is an
ocean in a box.

Two answers are defensible:

- **A — an island adds behaviour.** The server renders the content; the island
  binds interaction to markup that is already there. Costs nothing, and a failed
  chunk degrades to a page that still says everything it was going to say.
- **B — islands are server-rendered too**, then hydrated, the way Astro does it.
  Bigger machine: an SSR entry per adapter, and markup that has to match.

**A as the default, B per island when a case earns it.** Documented as a rule, not
a convention, because A is only free while it is followed.

## Adapters beyond Vue

Vue first, because it is the one already measured. Each further adapter needs
exactly three things:

1. a mount function — `createApp().mount()`, `hydrateRoot()`, Svelte's `mount()`
2. its Vite plugin
3. an SSR entry, if and only if that adapter supports **B** above

Nothing else in the design is framework-specific: the attributes, the escaping,
the glob registry, the per-island chunks, the immutable caching are all neutral.
Bridgetown (Ruby) and Enhance (web components) ship the same shape, which is the
strongest evidence the contract is not JavaScript's.

### decision: how does the runtime choose an adapter?

File extension is the cleanest signal — `MemberTable.vue`, `Chart.jsx`,
`Editor.svelte` — because the registry can be one glob per adapter and there is no
second place to keep in step. A directory per framework works too and reads worse
at the call site: the page names an island, not a technology.

One page may mix them. It costs one runtime per framework *used on that page*, and
two islands from different adapters cannot share reactive state — they are separate
applications, so the channels are server props, DOM events, or a store outside
both. Two components that must follow each other closely are one island, not two.

Worth it for a migration, or for a library that exists in only one framework.
Not worth it as a habit.

## Navigation that feels instant, without a protocol

Both demos navigate by loading a document. Measured after the first visit, with
assets already cached:

| navigation | server | document | assets re-fetched |
| --- | --- | --- | --- |
| → `/settings` | 5 ms | 3,348 B | its own chunk, 1,150 B |
| → `/dashboard` | 3 ms | 24,536 B | none |
| → `/settings` again | 4 ms | 3,348 B | none |

Only the document crosses the wire, and the server spends single-digit
milliseconds on it. What is left to buy is the round trip itself, and the cheapest
way to buy it is speculative prefetch — `speculationrules`, which lets the browser
fetch the next document while a cursor approaches the link. No protocol, no client
router, and nothing from the list of things a multi-page application gives up.

That list is the reason this is the direction rather than an Inertia-style JSON
protocol: client state resets on navigation. The demo shows it deliberately — a
theme survives in `localStorage` while a Pinia counter starts again. An editor
with an unsaved draft, a player that must keep playing, a socket that must stay
open: those are what a document-per-navigation cannot hold, and prefetch does not
change that. It changes how long the change takes.

## Conditional requests for static files

`@elysiajs/static` sets an `ETag` and then ignores `If-None-Match`. Measured on a
built application: a conditional request for an 81 kB script came back **200 with
all 81,048 bytes**, every time.

The compression layer in `@elvel/view` answers 304 for what it serves — measured,
31,725 bytes became 0 — but it only serves what it compresses, plus everything
under the build prefix. A `.png` outside that prefix still cannot be revalidated.

Closing it means answering `If-None-Match` for every static file rather than only
those two cases, which is a small handler in front of the plugin and not a change
to the plugin.

## decision: compress HTML too

Only files are compressed today, never a rendered page. What that leaves on the
table, measured per page: **16,497 B** on the island demo's members page and
**24,234 B** on the Vue demo's dashboard — both would compress to roughly 2 kB.

It was left alone because a response that mixes a secret with something the caller
controls — a CSRF token beside a reflected search term — is the shape that makes
compressing dynamic HTML a subtle question, and at the time the measured waste was
entirely in the assets. It is not any more: assets are compressed, so HTML is now
the largest uncompressed thing on every page.

Common practice compresses it — nginx does by default. The question is whether
this framework does it itself, leaves it to whatever sits in front, or offers it
behind a config key that is off by default.

## decision: what the default log stack writes

The scaffolded `stack` channel contains `['console']`. Nothing writes a file, so
`storage/logs` stays empty — which reads as a bug to anyone who arrives from
Laravel, where the default stack writes `storage/logs/laravel.log`.

Either the default gains a file channel, or the divergence is documented where
somebody looking for their logs will find it. Doing neither is what happens now.

## Numbers still missing

The runtime cost of adapters other than Vue. Package-entry sizes — including the
ones bundlephobia reports — do not answer it: it lists `react-dom` at 1.4 kB gzip
while the reconciler is imported lazily behind that entry, and `vue` at 45.1 kB
while the runtime-only build actually served here measured 24,787 B.

The only measurement worth having is a real island per framework, built and served,
read off the chunk Vite emits. That is what produced the Vue number.

---

## Not planned, and why

**A whole-page Vue SSR kit.** `.demo/vue-demo` proved the shape works and also
what it is: Blade with a different template engine. Everything it does well, the
JSX kit already does, and the thing people expect from it — client-side navigation
— is exactly what it does not have. Islands are the part of it worth keeping.

**An Inertia-style protocol.** Measured advantage on a fifty-row page: 222 bytes
gzipped, against a UI that talks to the backend over a channel of its own. The
same 24 kB document that made it look attractive is better attacked by compressing
HTML, which costs nothing architecturally.

**A client-side router with an API behind it.** Two applications to keep in step,
and the server-driven simplicity — `errors()`, `old()`, a redirect that carries a
message — is the thing being traded away. It is the right answer for an
application whose pages are one long-lived session; it is the wrong default for a
framework whose shape is Laravel's.
