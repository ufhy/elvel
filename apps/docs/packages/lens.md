# Lens

What the application just did, recorded and readable. Every request with the
queries it ran, the exception it threw, the mail it sent and the jobs it
dispatched — collected as one unit of work, not seventeen unrelated log lines.

Lens is Laravel Telescope's shape, read closely and rebuilt for Bun. It is an
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

What the page you are looking at just did, drawn into the page itself.

```bash
LENS_BAR=true
```

That is the whole installation. Unset, it follows `APP_DEBUG` — Laravel
Debugbar's rule, and the right one: a bar showing query results belongs to the
same switch as a stack trace in the browser.

Unlike the dashboard, **the bar needs no tables**. It reads a ring of the last
twenty requests held in memory, so there is no migration, no provider, no prune
and nothing growing on disk. An application that wants only the bar installs
nothing.

### It is not a second Debugbar

Laravel Debugbar is a separate package with its own collectors sitting beside
Telescope's. An application running both collects everything twice, configures
it twice, and can have the two disagree.

Everything on this bar was recorded by the watchers that feed the dashboard,
judged by the same filters. The bar is a reader. The only thing added to the
request path is a script tag.

That follows from *when* a batch is finished: after the response has already
been sent. The data cannot travel inside the page even if it wanted to, so the
markup carries a batch id and the browser asks for the rest — where a Debugbar
page carries its whole payload inline and grows tens of kilobytes for it.

### What it shows

The strip names the request, its status and its duration, then one chip per
entry type. Clicking a chip opens the panel:

- **the last twenty requests** down the left, whatever they answered with — the
  JSON your page fetched is in the list beside the page itself
- **every query** with its duration and the application line that ran it
- **`N+1 ×12`** on the chip when the same statement ran twelve times — counted
  across the whole request, not over neighbours, because a loop that renders
  between queries still runs the same statement twelve times
- **open any entry** for the same detail the dashboard shows: a request's
  headers, payload, session and response; an exception's stack with the source
  around the failing line; a query's bindings and connection — objects as a
  collapsible tree, not a flattened string, plus the raw JSON underneath and a
  button that copies it
- **jump to your editor** from any query, exception or dump, once
  `LENS_BAR_EDITOR` is set:

```bash
LENS_BAR_EDITOR="vscode://file/{file}:{line}"
```

It is empty by default rather than guessing, because a link that does nothing is
worse than the path written out.

### It keeps up

The bar wraps `fetch` and `XMLHttpRequest`, so a call your page makes after it
loads appears in the list as soon as it settles — with its own queries, its own
exception, its own everything. No reload, and the wrapper never touches the
request itself: it waits for it to settle and then asks the server what is new.

`Ctrl` + `` ` `` opens and closes the panel. Drag its top edge to resize it; the
height and the open tab are remembered per browser.

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

### What it deliberately is not

There is no component tree of the React or Vue DevTools kind, and there cannot
be: `@kitajs/html` compiles JSX to a string on the server, so at runtime there is
no component instance, no state and no re-render to highlight. The view watcher
also does not record props, because a view's props are the page's contents.

What you get instead is which components rendered, how large each was and how
long it took — the answer to "what is making this page half a megabyte", not to
"why did this component render again".

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
half is not copied: in Laravel `local` means a machine somebody is developing
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

Yes, and Laravel says the same of Telescope. What is not optional is the
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
