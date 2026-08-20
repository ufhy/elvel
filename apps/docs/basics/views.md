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

export default controller('page').get('/', () => view(Welcome, { title: 'Welcome' }))
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

::: warning There is no compile-time check for this
`@kitajs/ts-html-plugin` catches missing `safe` at build time, and it cannot run
here: its CLI reads `typescript.sys`, which TypeScript 7 removed from the default
export, so it crashes under both Bun and Node. This is the one feature that was
attempted and could not be made to work. Until it can, `safe` is a runtime
guarantee and a review responsibility.
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

## Static files

The provider mounts `@elysiajs/static` on `public/`. In development files are
resolved per request, so a newly added image needs no restart; in production the
route table is precomputed and served `public` with a day's `max-age`. Turn it off with
`view.serveStatic: false` when something in front of the application already
serves them.
