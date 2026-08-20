# Concurrency

Run several tasks at once, on more than one core.

```ts
import { concurrency } from '@elvel/concurrency'

const [sum, label] = await concurrency().run([() => 1 + 1, async () => 'two'])
// [2, 'two']
```

## Reach for it only when the work computes

`Promise.all` already covers everything I/O-bound, which is most of what a
request waits for — two queries, three API calls, a read and a write. Those are
already concurrent, and a worker would only add the cost of starting one.

This is for work that *computes*: a report over a large dataset, an image
pipeline, a hash over many rows. That is the only case where another core buys
anything.

```ts
// config/concurrency.ts
driver: process.env.CONCURRENCY_DRIVER ?? 'worker'   // worker | sync
```

## `sync` accepts a closure; `worker` does not

```ts
// sync — this process, one after another
await concurrency('sync').run([() => 1 + 1, async () => 'two'])

// worker — another core, so the task has to be nameable
await concurrency('worker').run([
  { module: './app/Reports/build.ts', export: 'build', args: [2026] }
])
```

::: warning A function cannot be sent to a worker, and the reason is worse than "closures do not travel"
`Function.prototype.toString()` gives the body without the scope, which is the
expected half. The other half is that **Bun's transpiler inlines a captured
`const` primitive into the source**: `const name = 'ada'` followed by
`() => name.toUpperCase()` stringifies as `() => "ada".toUpperCase()` and works in
a worker, while the identical code written with `let` stringifies as
`() => name.toUpperCase()` and throws `ReferenceError`.

A feature whose success depends on which keyword declared a variable is a trap,
so `WorkerDriver` refuses a function outright and asks for
`{ module, export, args }`.
:::

That also makes `sync` a **poor rehearsal** for `worker`: a suite that passes on
`sync` proves nothing about whether the same tasks can cross a thread boundary.
Test with the driver you deploy with.

## What crosses the boundary

`structuredClone` decides. A value it cannot copy fails at the moment it is
returned rather than as an opaque error in the parent, and an error thrown inside
a worker comes back with its message, stack and name intact rather than as
`[object Object]`.

Each worker receives one task, answers with one message, and exits. Deliberately
not a pool of long-lived workers keeping state: a task that left something behind
would poison the next one, and the whole reason to reach for a worker is that the
work is big enough for the startup cost not to matter.

## `defer` is the other tool

For work that should happen *after the response is sent* rather than on another
core — a cache refresh, a log write — `defer()` from `@elvel/core` is smaller and
cheaper. The [cache page](/digging-deeper/cache#flexible-stale-while-revalidate)
shows it holding a stale-while-revalidate refresh.
