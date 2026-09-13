# Lens

What the application just did, recorded and readable. Every request with the
queries it ran, the exception it threw, the mail it sent and the jobs it
dispatched — collected as one unit of work, not seventeen unrelated log lines.

Lens is Telescope's shape, read closely and rebuilt for Bun. It is an
**optional package**: no starter kit installs it, nothing in the framework
depends on it, and an application that never asks for it never pays for it.

```bash
bun add @elvel/lens
bun elvel lens:install
```

## Installing

`lens:install` publishes two files and then tells you the three things it will
not do on your behalf:

```
Published config/lens.ts
Published app/Providers/LensServiceProvider.ts

Three steps left:
  1. Name the config in bootstrap/app.ts:  lens: () => import('../config/lens.ts')
  2. Register both providers, Lens after HttpServiceProvider:
       LensServiceProvider (yours), then LensServiceProvider from @elvel/lens
  3. Create the tables:                    elvel lens:table && elvel migrate

Then add yourself to authorise() and set LENS_ENABLED=true.
Both are refusals until you do: the gate denies everyone and recording is off.
```

Two providers, because two decisions belong to you and not to the package: **who
may read the dashboard**, and **what is worth keeping**. Yours is a subclass of
`LensApplicationServiceProvider` and is never overwritten, `--force` or not — it
holds the guest list.

::: tip Not in `config:publish`
Lens publishes its own config. `config:publish` is a catalogue of capabilities
an application configures and then calls; a tool has to be *installed*, and the
config alone is inert without the tables and the provider. Telescope draws the
same line.
:::

Stuck? `lens:status` answers the first ten minutes of questions in one screen:

```bash
bun elvel lens:status
```

```
  Recording ..... on
  Tables ........ ready
  Driver ........ database
  Dashboard ..... /lens

  request ....... 1,284
  query ......... 9,530
  exception ..... 3
  total ......... 10,817
```

## What it records

Seventeen watchers, one per entry type:

| | |
| --- | --- |
| `request` | Method, path, status, duration, headers, payload, response |
| `query` | SQL, bindings, duration, the application line that ran it |
| `exception` | Class, message, the frame, and the occurrence count |
| `log` | Anything at or above `LENS_LOG_LEVEL` |
| `cache` | Hit, miss, set, forget — **including the value** |
| `gate` | Ability, result, and the policy that decided |
| `model` | Created, updated, deleted |
| `job` | Pushed, processing, processed, failed, with the retry trail |
| `batch` | Job batches, their progress and their failures |
| `schedule` | Every scheduled task, its expression and its output |
| `mail` | Recipients, subject, and a **previewable** body |
| `notification` | Channel, recipient, and whether it queued |
| `event` | Every dispatched event and its listeners |
| `command` | Console commands, arguments, exit code |
| `client_request` | Outgoing HTTP through `@elvel/http-client` |
| `view` | Components rendered, and their data |
| `dump` | Whatever `dump()` was given |

`redis` is the one Telescope type with no counterpart here — Elvel has no Redis
package to watch.

`event` and `dump` are **off by default**. A wildcard event listener sees
everything an application dispatches, which is the most useful screen in some
applications and pure noise in others; a dump is written to be read now, in the
terminal. Turn either on deliberately.

## The dashboard

Served at `/lens`, server-rendered, no build step and no client bundle.

Each entry type gets its own list with columns that suit it, and every entry
links to the **whole batch it belonged to** — click an exception and the queries
that led to it are right there, in order.

### The waterfall

Telescope shows a batch as a list. Lens draws it as a timeline: one bar per
entry, positioned by when it happened inside the request and sized by how long
it took. A request that spent 400 ms in one query looks different from one that
spent 400 ms in forty, at a glance, before reading anything.

Adjacent repeats fold into `×N`, which is what an N+1 looks like on the screen.

### Monitoring a tag

The escape hatch for production. Add `auth:41` from the Monitoring screen and
every entry carrying that tag is kept, whatever the filter says, until you
remove it. No deploy, no config change — one user reports a bug, you watch that
user.

## The inspection bar

Not a debug bar. A debug bar counts things — twelve queries, three views — and
leaves the reading to you. This one reads first:

```
3 problems   GET /slow 200   14ms ▓▓▒░  db 4.4ms  view 0.3ms  app 9.3ms   10 query …
```

```bash
LENS_BAR=true
```

That is the whole installation. Unset, it follows `APP_DEBUG` — the
Debugbar's rule, and the right one: a bar showing query results belongs to the
same switch as a stack trace in the browser. **No tables are needed**: the bar
reads a ring of the last twenty requests held in memory.

### It tells you what is wrong

Every unit of work is analysed on the server as it closes, and the panel opens
on the findings:

| | |
| --- | --- |
| **The same query ran 8 times** | The statement, and the line that ran it. An N+1 named, not badged |
| **A query took 240ms** | With its caller |
| **80% of this request was the database** | Said only when no single query is to blame |
| **1 exception thrown, and the page still answered 200** | Something threw, something caught it, and the browser never knew |
| **Cache key `user:1` missed 2 times** | A cache that is not caching |
| **1 error-level log message** | Logged and forgotten |
| **The response was 293 KB** | Large enough that the browser feels it first |

A request with nothing wrong says so, in one line. That matters as much as the
rest: a bar that always has something to complain about is a bar nobody reads.

### It profiles

Press **Profile**, reload, and the bar shows a real CPU profile of that request:
self time per function, sorted, each one a link into your editor.

```
Sampled 14ms · Samples 9 · Idle and engine 3.0ms

2.5ms  jsx                     @kitajs/html/index.js
1.5ms  getOwnPropertyDescriptor  packages/database/src/…
1.3ms  cloneWheres             packages/database/src/query/types.ts
```

This has no equivalent in the tools Lens is shaped after. Telescope, Debugbar
and Clockwork can all say a request took 900ms and that 40ms of it was the
database; none can say where the other 860ms went, because PHP cannot profile
itself without Xdebug and a separate UI. Bun's `node:inspector` Profiler runs
in-process, so the answer is one button away.

Two honest limits. The profiler is **process-wide**: a request served
concurrently with the profiled one lands in the same samples, which is why it is
armed by hand for a single request rather than left running. And sampling starts
when you press the button, so the profile is clipped to the request's own window
— the wait in between is dropped rather than charged to whichever function the
sampler woke up inside.

### The timeline

The split says how much; clicking it says **when**, and next to what.

It opens on the request's own stages — arrival, middleware, handler, response,
sent — as one band with each segment's cost:

```
▓▓░░░░░░░░████████████████████████████████░░  middleware 1.5ms · handler 2.0ms · response 0.0ms · sent 0.5ms
```

That band is what a list of entries cannot tell you. Watchers record what the
*application* did; this is what the framework was doing around it, so time spent
in neither the database nor rendering stops being a number with no shape. An
unmatched path has fewer stages, because Elysia runs neither the before- nor
after-handle stage for one — which is itself the answer to why a 404 was fast.

Below it, one bar per entry, placed where it happened and sized by how long it
took. An N+1 is a picket fence. A slow query is one long bar with nothing beside
it. Clicking a bar opens that entry.

### It knows what is normal

```
5.0ms ▓▒░  db 1.0ms  view 0.1ms  app 3.9ms   3.2× median
```

The process is long-lived, so it remembers what each **route** usually costs and
says how this request compares — beside the timing rather than as a tab of its
own, because a multiple is only known once a route has been seen a few times and
a tab that comes and goes reads as the bar rearranging itself. PHP-FPM forgets everything between requests, so
no debug bar in that world can answer "is this slow, or is this page always like
this". The Route cost view lists every route seen this session, slowest first.

### The evidence is underneath

Three panes, each with one job and none of them replacing another: **Recent** on
the left is which request you are looking at, the middle is what about it, and
the right is the detail of one thing. Choosing another request keeps the view you
were in.

Findings are the first thing, not the only thing. Selecting one summarises its
evidence in place —

```
8 × query · total 0.3ms · slowest 0.1ms · first at 2.0ms · last at 3.0ms   [Show in query]
```

— rather than repeating eight identical statements, which is a list of the same
thing eight times. **Show in query** hands off to the tab that owns those rows,
filtered to them.

Every count in the strip opens the entries behind it — filterable — and every
entry opens the same detail the dashboard shows: a request's headers, payload, session and response; an
exception's stack with the source around the failing line; a query's bindings and
connection. Objects render as a collapsible tree, with the raw JSON underneath
and a button that copies it.

Set an editor and every file reference becomes a link:

```bash
LENS_BAR_EDITOR="vscode://file/{file}:{line}"
```

### It keeps up

The bar wraps `fetch` and `XMLHttpRequest`, so a call your page makes after it
loads appears in the list as soon as it settles — with its own findings. No
reload.

`Ctrl` + `` ` `` opens and closes the panel. Drag its top edge to resize it; the
height and the open view are remembered per browser.

### Work in other processes

`bun elvel dev` runs the queue worker and the scheduler beside the server, each
in its own process, and the bar's ring lives in memory. A job's batch is
therefore invisible to the server that draws the bar.

When `LENS_ENABLED=true` the bar closes that gap through the one place both
processes can see: the tables. Its list becomes the union of this process's ring
and the batches storage knows about that have no request of their own — jobs,
scheduled tasks, console commands. They appear as rows you can see but not open,
because only the ring holds their detail; the dashboard has the rest.

Without storage the bar is this process only, and says so at the foot of the
list rather than showing an empty screen that reads as "nothing ran".

### It is not a second Debugbar

Debugbar is a separate package with its own collectors sitting beside
Telescope's. An application running both collects everything twice, configures
it twice, and can have the two disagree.

Everything the bar reasons about was recorded by the watchers that feed the
dashboard, judged by the same filters. The only thing added to the request path
is a script tag — the data cannot even travel inside the page, because a batch is
flushed after the response has gone, so the markup carries a batch id and the
browser asks for the rest.

### What it deliberately is not

There is no component tree of the React or Vue DevTools kind, and there cannot
be: `@kitajs/html` compiles JSX to a string on the server, so at runtime there is
no component instance, no state and no re-render to highlight. The view watcher
also does not record props, because a view's props are the page's contents.

What you get instead is which components rendered, how large each was and how
long it took.

### Running it outside development

Setting `LENS_BAR=true` while `APP_DEBUG` is off is allowed — staging is a real
place — and it changes one thing: the bar then appears only for a request that
passes your `authorise()`. Nothing is injected for anyone else, so an anonymous
visitor is not even told Lens is installed.

That lock is the difference from Debugbar, where config wins over debug with
nothing behind it, and where every leak has come from exactly that combination.

A streamed page (`stream()` from `@elvel/view`) never gets a bar. Appending to it
would mean buffering it, and buffering it is the one thing streaming forbids.

## Deciding what is kept

The published provider filters, and **`filterBatch` rather than `filter` is the
decision that matters**:

```ts
// app/Providers/LensServiceProvider.ts
lens().filterBatch((entries: IncomingEntry[]) => {
  if (local) return true

  return entries.some((entry) => (
    entry.isException() ||
    entry.isFailedRequest() ||
    entry.isFailedJob() ||
    entry.isScheduledTask() ||
    entry.isSlowQuery() ||
    entry.hasMonitoredTag()
  ))
})
```

Judging entries one at a time keeps the exception and throws away the queries
that caused it — the failure with the reason for it removed, and an empty
waterfall on the one page you opened it for. `filterBatch` keeps the whole unit
of work when anything in it qualifies.

`filter(entry => …)` still exists for the narrower job of dropping one kind of
entry everywhere. Every registered filter must agree before an entry is kept.

### Tags of your own

```ts
lens().tag((entry) => entry.isRequest() ? [`tenant:${tenantId()}`] : [])
```

Tags are a separate, indexed table, so a tag is something you can search by —
and something the Monitoring screen can pin.

## Who may read it

`authorise()` **refuses everyone** until you fill it in:

```ts
protected override async authorise(_request: Request): Promise<boolean> {
  const signedIn = user()

  if (signedIn === null) return false

  return ['you@example.com'].includes(String(signedIn.email))
}
```

Telescope's default is `environment('local') || Gate::check(...)`. The `local`
half is not copied: `local` usually means a machine somebody is developing
on, but here a server with an empty `HOST` binds every interface, so "local" is
not a statement about who can reach it.

`@elvel/lens` deliberately does not depend on `@elvel/auth`. The gate is a
method you fill in, so an allow-list of IPs, a header, a signed link or a real
Gate ability are all equally served — and the recorder still works in a queue
worker with no HTTP layer at all.

## Hiding what should not be stored

Outside `local` the published provider masks the obvious things:

```ts
lens().hideRequestParameters(['_token'])
lens().hideRequestHeaders(['cookie', 'x-csrf-token', 'x-xsrf-token'])
lens().hideResponseParameters(['token'])
```

`cookie` matters most: a session cookie in a table anybody with the dashboard
can read is a session anybody with the dashboard can take.

Worth knowing beyond that — **the cache watcher records values**, and the mail
watcher records bodies. `watchers.cache.hidden` and `watchers.cache.ignore` take
a name or a `prefix*` glob.

## Configuration

`config/lens.ts`, and every watcher is either `false` or its options:

```ts
watchers: {
  query: {
    enabled: env('LENS_QUERY_WATCHER', true),
    slow: 100,               // ms at or above which a query is tagged `slow`
    ignorePaths: []
  },
  log: { enabled: true, level: env('LENS_LOG_LEVEL', 'error') },
  event: false               // not registered at all
}
```

`false` and `{ enabled: false }` mean the same thing, and it is stronger than it
looks: nothing is constructed, so a disabled watcher costs nothing rather than
costing a listener that returns early.

Top-level keys worth knowing:

| | |
| --- | --- |
| `enabled` | `LENS_ENABLED`, **off by default** |
| `path` | Where the dashboard is served, `lens` |
| `ignorePaths` | Not recorded. `lens-api*` is in here so it cannot watch itself |
| `ignoreCommands` | `queue:work` and friends — a worker loop would record forever |

## Running it

```bash
bun elvel lens:pause     # stop recording, no deploy
bun elvel lens:resume
bun elvel lens:prune --hours=48 --keep-exceptions
bun elvel lens:clear     # everything
```

`lens:pause` writes a cache key rather than a config value, so it takes effect
across every process without a restart.

## In production

Yes, and the same is said of Telescope. What is not optional is the
configuration you run it under.

The flush happens in `onAfterResponse` — the response has already gone out
before a row is written, so the client never waits for Lens. What is paid for is
event-loop time and database connections. **Measured with `wrk`:**

| | req/s |
| --- | --- |
| Lens off | 10,797 |
| Every watcher, no filter | 2,108 |
| The published production filter | 8,573 |

Roughly 21% of throughput and +1.1 ms at p50, and it is almost entirely the cost
of *writing*: the middle row produced 95,603 rows in 15 seconds, the last one a
few hundred.

Three things, none of them optional:

1. **Keep `filterBatch`.** Deleting it is the fastest way to turn Lens into an
   outage.
2. **Fill in `authorise()`.** The dashboard shows request bodies, query results
   and mail contents.
3. **Schedule `lens:prune`.** Nothing prunes on its own.

```ts
schedule.command('lens:prune', ['--hours=48']).hourly()
```

There is no sampling, and that is deliberate: sampling decides for you which
requests are interesting, and the ones worth having are usually the rare ones.
Everything that passes the filter is kept, for a window, and `--hours` sets the
window.

## Storage

Three tables, `database` the only driver.

`lens_entries` is keyed by an auto-incrementing `sequence` and identified by a
`uuid`. Both are needed: the `uuid` exists before the row does, so a whole batch
can be assembled in memory and inserted at once, and `sequence` gives the list a
**keyset** cursor — `where sequence < ?`, not an offset, because entries keep
arriving while somebody is reading page two.

`should_display_on_index` is what turns one exception with five hundred
occurrences into a single row on the list and five hundred once you click it.

`lens_entries_tags` is a table and not a JSON column so a tag can be indexed.
`lens_entries_monitoring` holds the tags being watched.

## One departure from Telescope

Telescope keeps the open batch in a static property. It can: PHP-FPM serves one
request per process. Bun serves many at once in one process, and a static queue
would attribute one request's queries to another — so the batch lives in a
**request slot** backed by `AsyncLocalStorage`.

This is not a detail. Swap the slot for a static and seven tests in the package
fail, all of them about two concurrent requests seeing each other's entries.
