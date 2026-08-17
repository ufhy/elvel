# Behaviours worth knowing

Why some things here work the way they do — the decisions that are easy to
misread from the outside, and the failures that led to them.

Everything below is behaviour that already exists and would otherwise have to be
rediscovered — through a bug, usually, since none of it can be read back off the
code. The code says what happens; this says why.

It had a companion, `GAPS.md`, holding what was still missing. Three of them have
now counted down to zero and been deleted, which is the only way their length ever
meant anything — the third because the second measured the wrong thing: it
compared Laravel *component by component* and found 30 of 38 covered, while the
real distance was inside them. Measured at method level against 13.25.0, that
distance is closed as well; the `gh api` recipe for re-measuring is in the git
history, and a fourth list belongs there only when there is real debt to count
again.

The limits that outlive any such list — the places this framework simply stops —
are at the bottom of this file.

---


## @elysian/database — complete for this milestone

Two things to know about walking a table:

- **Bun's SQLite driver reports no affected rows for `insert … select`.** An
`update` answers with its count and an `insert … select` answers 0 while
inserting the rows perfectly well, so `insertUsing()` returns 0 there. Reported
as it comes back rather than counted separately: a second `select count(*)` to
make the number look right would cost a round trip and still be a guess about
what the first statement did.

**`chunk()` pages by offset and `chunkById` pages by key**, and the difference
  shows the moment rows are deleted while walking — which is the commonest reason
  to chunk at all. Every delete shifts the offset window back by one, so an offset
  walk silently skips rows it never handed over. There is a test that deletes as it
  goes and asserts `chunk()` sees fewer than it should, because that behaviour is
  worth pinning rather than discovering.
- **A cursor page has no total.** Knowing one costs a `count(*)` over the whole
  set, which is the expense cursor pagination exists to avoid. What it buys is a
  page that cannot repeat or skip a row when something is inserted mid-read.

Two things to know about the single-row relations:

- **`latestOfMany` is a joined subquery, not `orderBy().limit(1)`.** The limit is
  right for one parent and silently wrong for an eager load, where it returns one
  row for the entire set — so the first parent gets its newest child and everyone
  else gets nothing. What is joined is `max(column)` grouped per parent.
- **The key is aggregated alongside the column.** Two children can share a
  `created_at`, and without the key in the join the aggregate matches both — a
  "one" relation quietly returning two. There is a test that creates the tie on
  purpose.

Three things to know about pivots:

- **Pivot columns travel aliased and are then moved.** They are selected as
  `pivot_<column>` and lifted onto the accessor after hydration, which is what
  stops a pivot's `created_at` from overwriting the model's own. The aliases are
  removed *before* `syncOriginal`, or every eagerly loaded model would report
  itself dirty.
- **A pivot model is built by assignment, not by `fill()`.** `fill` honours
  `fillable` and a pivot declares none, so constructing one with its attributes
  produced an empty pivot — silently. `hydrate()` bypasses fill for the same
  reason.
- **The morph direction decides whose type is stored.** `morphToMany` stores the
  parent's, `morphedByMany` the related model's. Backwards, the relation returns
  nothing at all rather than failing, so both directions are covered by tests on
  SQLite, Postgres and MySQL.

**Verified limits of the databases themselves**, not of this code:

- MySQL refuses to `truncate` a table a foreign key points at, however empty the
  child is. Use `delete()`. The grammar does not silently disable foreign key
  checks.
- MySQL implicitly commits DDL, so a failing migration cannot be rolled back
  there. Migrations are wrapped in a transaction on SQLite and Postgres only —
  it is not pretended for MySQL.
- MySQL's system schema `mysql` does **not** enforce InnoDB foreign keys. The
  dialect test suite provisions its own database because of it.
- Lazy loading a relation cannot be synchronous on Bun: reaching the database is
  async, so `user.posts` cannot return rows the way `$user->posts` does. Relations
  are methods (`await user.posts().get()`), and `with()` prevents the N+1.


## SQLite — one file, several processes

- **WAL is on unless the config says otherwise.** SQLite's default journal locks
  the whole database for a write, so a second process is refused the instant it
  arrives: `database is locked`, with nothing to wait for. Write-ahead logging
  lets readers carry on while one writer works, which is what makes a test suite
  and a running `artisan serve` able to share a file at all. `journalMode:
  'delete'` restores the old behaviour for a filesystem where WAL cannot work —
  a network share, since WAL needs shared memory.
- **`busy_timeout` is set before the journal mode, and the order is the point.**
  Switching the journal takes an exclusive lock, so it is itself a statement that
  can be refused; with no timeout set yet it is refused at the exact moment it
  was needed. This was found by two test suites running at once, which is also
  how it is tested.
- **An in-memory database is left alone.** There is nothing to contend for and no
  journal to switch.
- **The playground's tests use a database of their own.** Even with WAL, one file
  shared by the tests, the smoke run and a running server is a file that is being
  migrated out from under somebody. Laravel's answer is the same: a separate
  database for testing.


## @elysian/events

Four things to know about a queued listener:

- **It is a class, not a closure.** A worker is a different process, so only a name
  travels — the same constraint jobs have. `QueuedListener` is what a worker can
  resolve; anything in `app/Listeners` is discovered, and `artisan make:listener X
  --event Y --queued` writes one.
- **The event is rebuilt from its class, not handed over as data.** `app/Events` is
  discovered into a registry, and the payload is poured into an instance without
  running the constructor — so `event.label()` and `event instanceof OrderShipped`
  still work inside the worker. An unregistered event still delivers its fields;
  what it loses is exactly those two things.
- **`shouldQueue(event)` is asked in the dispatching process.** That is the only
  place that still has the request's state to decide with.
- **`afterCommit` holds the push until the outermost transaction commits**, and
  drops it entirely if that transaction rolls back. Without it a worker can reserve
  the job first and find none of the rows the event is about. Outside a transaction
  there is nothing to wait for, so it pushes at once.

Two things to know about `defer()`:

- **It is per async context, not per dispatcher.** Laravel can hold the deferral
  on the instance because one request is one process; here a single dispatcher
  serves every request at once, and a flag on it would swallow the events of
  whatever else happened to be in flight. The deferral follows the callback's
  async context through `AsyncLocalStorage`, so an overlapping request neither
  loses its events nor inherits somebody else's rollback.
- **`until()` is never deferred.** A halting dispatch is a question, and holding
  one would answer `null` before a single listener had run — which reads as
  "nobody objected". Laravel defers it because `until` is `dispatch(…, halt:
  true)` there; here it runs at once, inside a deferral as it would outside one.

The dispatcher itself knows nothing about queues: the push arrives as a hook that
`QueueServiceProvider` installs. A queued listener with no queue registered throws
and names the provider — running it in the request would look like it worked.


## @elysian/validation

Four things to know about file rules:

- **The bytes decide, not the headers.** `image` and `mimes` sniff the file's
  signature; a script renamed `avatar.png` arrives claiming `image/png` and
  nothing else about it disagrees. `extensions` is the opposite rule on purpose —
  it checks the *name* and says nothing about the contents.
- **Only a handful of formats can be sniffed** — PNG, JPEG, GIF, BMP, WebP. For
  anything else `mimes` falls back to the type the client declared, which is a
  claim; `mimetypes:` takes a media type directly, and the extension table is
  deliberately short rather than pretending to cover everything.
- **A size rule on an upload is kilobytes.** `max:2048` is 2MB, matching Laravel,
  and the message says "kilobytes" rather than "characters".
- **Executable extensions are refused unless named.** `mimes:txt` will not accept
  `run.sh` or `x.phar`; `mimes:php` will. Laravel blocks the PHP family the same
  way, widened here to the obvious shell and Windows cases.

Three things to know about wildcard rules:

- **Expansion walks the pattern, it does not filter the data.** `items.*.price`
  against `items: [{ price: 1 }, {}]` produces `items.1.price` even though nothing
  is there — an attribute that does not exist cannot fail `required`, and "you
  forgot the price on the second line" is the whole point.
- **A missing or wrong-typed collection reports itself, once.** With `items`
  absent, `items.*.price` contributes nothing and the rule on `items` is what
  fails. Inventing `items.0.price` would report one problem twice, in a place the
  sender never wrote.
- **`distinct`'s scope is the pattern.** `orders.*.lines.*` compares every line of
  every order against every other, because that is what the pattern names; scoping
  it per order means writing the rule per order.


## @elysian/http

- **`app.handle()` needs a URL at least 12 characters long before the path.**
  Elysia slices the path out of `request.url` at a fixed offset, so
  `new Request('http://x/thing')` routes to nothing and answers 404 while
  `http://localhost/thing` works. `@elysian/testing` uses `http://localhost` and
  is unaffected; a handwritten `app.handle()` in a test is where this bites.
- **A request body can be read once, and `clone()` is not a licence to read it
  twice.** `methodOverridePlugin` cloned the request once to find `_method` and
  again to build the request it passed on; the second clone came back with the
  body **repeated**. Elysia then parsed `_token` as two values joined by a
  newline, so every method-spoofed form failed CSRF with an 81-character token
  against a 40-character one. Read the body once into bytes and reuse them.

Three things to know about maintenance mode:

- **The payload is a file, not the cache.** The likeliest moment to need
  maintenance mode is when the database or Redis is the thing that is broken, and a
  mode that cannot be switched on then is not a maintenance mode.
- **`--render` renders when `down` runs**, not per request, and the HTML is stored
  in the payload. The reason to be down is often that the application cannot serve a
  page; asking it to render one then is asking the broken thing to explain itself.
- **The bypass cookie carries a MAC over its own expiry, never the secret.** So a
  copied cookie is a temporary problem rather than a permanent key, and the phrase
  never reaches a browser's history or storage. Visiting the secret URL redirects to
  `/` for the same reason.

Four things to know about the form loop:

- **`errors()` and `old()` read a request scope, not props.** A view here is a JSX
  component, so there is no template scope to share `$errors` into; threading a
  message bag through every component between the handler and the input it belongs
  to is the plumbing that makes people skip validation feedback. The scope is
  entered from a **synchronous** hook, because `enterWith` inside an async `derive`
  is already lost by the time the handler runs.
- **A failure redirects for a browser and 422s for a client**, decided by four
  signals: `X-Requested-With`, `Accept`, a **JSON request body**, and no `Accept` at
  all. The body signal was missing at first, and the playground's API routes started
  receiving redirects they could not follow.
- **A thrown redirect must persist the session; a returned one must not.**
  `onAfterHandle` is what saves, and it does not run on the error path — so a thrown
  redirect saves before throwing. Doing both saves the session twice, which ages the
  flash twice and destroys it before the next request reads it. Both halves were
  found by driving the form over the network.
- **A password is never flashed.** `withInput()` drops `password`,
  `password_confirmation`, `current_password` and `token` at every depth, along with
  uploads, rather than trusting each caller to remember.

Four things to know about the middleware:

- **`throttle()` is scoped to the plugin it is used in.** Putting one on a
  controller limits every route in that file against one budget; a `routeGroup()`
  per limit is how two routes get two budgets. The first draft of the playground
  controller got this wrong and reported one limit's numbers for another limit's
  route.
- **Two windows need two counters.** A named limiter returning
  `[perMinute(3).by(ip), perDay(50).by(ip)]` describes one subject through two
  windows, so the window length is part of the counter key: sharing one counter
  makes every request count twice and the tighter limit trip at half its stated
  number. That happened, and driving it over the network is what showed it. The
  headers report the *tightest* remaining rather than the last one read.
- **A refused CORS request is a normal response without the headers.** Answering
  403 would break same-origin callers of the same route — the browser is what turns
  the absence into an error. A refused origin is told nothing at all: not the
  methods, not the credentials flag, not the max-age.
- **`X-Forwarded-For` is believed only from a proxy you named.** Behind a load
  balancer you must trust it, or one rate limit is shared by the whole internet;
  directly exposed you must not, or a caller forges a fresh identity per request.
  `::ffff:127.0.0.1` is normalised to `127.0.0.1`, because Bun reports an IPv4
  client that way and a limiter comparing against the plain form would silently
  never match — an exemption that never fires being worse than none, since it
  looks like one.


## @elysian/auth

Two things to know when using it:
- **`{ user }` cannot be destructured from a controller's context and typed.**
  The derive that puts it there is registered globally by the provider, and
  Elysia types a context from the plugins *that instance itself* uses — so a
  controller written as its own `Elysia` instance has the property at runtime and
  not in the type. Use `userOf(context)` (or `maybeUserOf`), the same shape as
  `sessionOf`. Every handler in the auth kit had this, and a freshly scaffolded
  application failed `bun run typecheck` out of the box.
- **`AuthUser` is `{ id } & Record<string, unknown>`.** better-auth's user table
  is whatever the application's plugins make it, so the framework cannot promise
  a `name`. Narrow once, where the schema is known, rather than casting at every
  call site.

- The auth endpoints are registered per HTTP verb rather than through `all()`,
  and the provider must boot *before* the view provider: Elysia treats an `ALL`
  route as a fallback, so the static asset handler's `GET /*` would answer the
  auth endpoints first.
- The request scope is entered from a **synchronous** `onBeforeHandle`.
  `AsyncLocalStorage.enterWith` applies to the rest of the current execution, and
  an `await` restores the frame its continuation was scheduled with — so entering
  the scope inside an async `derive` is lost by the time the handler runs. There
  is a test for this arrangement, because it depends on Elysia not emitting an
  `await` for a synchronous hook.
- **Changing an email address is a different endpoint.** `updateUser` throws
  `EMAIL_CAN_NOT_BE_UPDATED` for any body containing an `email`; the change goes
  through `POST /change-email`, which exists only when
  `user.changeEmail.enabled` is on and otherwise answers 400 with "Verification
  email isn't enabled". With a *verified* address on file the change waits for a
  link sent to the **old** inbox — the direction being the point, since it is
  what stops a stolen session moving the account away. An unverified address is
  replaced outright when `updateEmailWithoutVerification` is on, so a typo at
  sign-up is fixable.
- **Every endpoint better-auth ships is off until the options say otherwise.**
  `changeEmail` needs `user.changeEmail.enabled`; `deleteUser` needs
  `user.deleteUser.enabled` and answers **404** without it, so a delete form
  reads as a missing route rather than a missing option. Both are on in the
  template's `config/auth.ts` because the kit ships forms for them.
- **`verifyPassword` throws rather than answering false.** A wrong password is an
  `APIError`, not `{ status: false }`, so it has to be called with
  `asResponse: true` — unhandled, a confirm-password form answers 500 to somebody
  who merely mistyped.


## @elysian/cache

Three behaviours worth knowing rather than discovering:

- **`funnel()` works on every driver, unlike Laravel's.** Laravel acquires a
  slot with a Lua script, which ties it to Redis. A `Lock` here is already atomic
  on every store, so N named locks are a semaphore that behaves the same on
  `array`, `file`, `database` and `redis` — at the cost of up to N round trips to
  find a free slot instead of one.
- **Tagged entries linger.** Flushing a tag rotates its id, so every key written
  under the old namespace becomes unreachable at once — but the entries stay until
  their own TTL runs out. That is what lets tags work without an index of which
  keys belong to which tag, and it is Laravel's design too.
- **`flush()` on Redis scans this store's prefix** rather than issuing `FLUSHDB`,
  which would take another application's keys with it. With no prefix configured
  there is nothing to scan for, and it does flush the database.


## @elysian/queue

Behaviours worth knowing rather than discovering:

- **`afterCommit` returns the uuid, not the driver's id.** A job held for a
  commit has no row and no Redis entry yet, so there is no identifier to hand
  back — and waiting for one would mean waiting for the commit, which is what the
  caller asked not to do. The uuid is what the failed table, the logs and a batch
  use anyway. A rollback drops the job rather than delaying it: the rows it was
  about never existed.
- **A timeout retries by default.** A timed-out attempt is usually the network
  having a bad minute, so it goes back on the queue like any other failure.
  `failOnTimeout = true` is for the other case — work that simply does not fit in
  the timeout will not fit on the next attempt either, and retrying spends every
  remaining try to reach the same failure, having done a fraction of the work
  again each time.

- **`maxExceptions` needs a cache.** The count is kept there, keyed by the
  payload's uuid, because it has to survive a release and a different worker
  reserving the job — the payload is rewritten on every release. With no cache
  registered the attempt limit is the only limit.

- **The callbacks are `onSuccess`/`onFailure`/`onFinished`, not
  `then`/`catch`/`finally`.** A class with a `then` member is a thenable, so
  `await queue().batch([...])` would call it with `resolve` and `reject` where job
  classes are expected. The scheduler dropped its own `then()` alias for the same
  reason; here the linter caught it.
- **A batch callback must not belong to its own batch.** Dispatching `then` with
  the batch id in its *payload* makes the batch count its own callback: pending is
  already zero, so finishing the callback finishes the batch again, which
  dispatches another callback, for ever. The id travels in the callback's data
  instead. Found by a test hanging rather than failing.
- **A chain inside a batch counts as all of its links.** An array in the job
  list is a chain, as in Laravel: every link carries the batch id and decrements
  the count as it succeeds. Counting the chain as one job would fire `onSuccess`
  while most of the work was still queued. A cancelled batch is why
  `queue:prune-batches` has a `--cancelled` window of its own — see below.
- **A cancelled batch's jobs are skipped, not deleted.** A driver has no random
  access and another worker may already hold one, so cancellation is checked when a
  job is reserved. A cancelled batch therefore stays unfinished, with a pending
  count for work that will never run — Laravel behaves the same way.
- **`app.handle()` never runs deferred callbacks.** Elysia fires
  `onAfterResponse` when a response is transmitted, and an in-process
  `app.handle()` transmits nothing. A test that needs `defer()` should call
  `flushDeferred()` itself, or drive a real socket — the smoke test does the
  latter.
- **A released job goes to the back of the queue** on the database driver: the row
  is deleted and re-inserted, so it gets a fresh id rather than jumping ahead of
  work that arrived while it was failing.
- **SQS owns its own reservations, so it has no `retryAfter`.** A received
  message is invisible for `visibilityTimeout` and a delete is what finishes it;
  there is no reserved set to migrate and no expiry sweep. Three consequences
  are the queue's, not ours: the attempt count is `ApproximateReceiveCount`, so a
  worker killed before it could release still increments it; `size()` is
  approximate and sums available, delayed and in-flight, so a "wait until empty"
  loop on it is a bug; and a delay over 900 seconds is **refused rather than
  clamped**, because a job arriving hours early is worse than one that never
  queued.
- **`retryAfter` must exceed your slowest job.** It is how long a reservation is
  trusted; a job still running when it expires will be picked up a second time,
  which is the same trade Laravel makes.
- **A timed-out job is abandoned, not killed.** Without process isolation there
  is no way to stop an async function already running, so the worker stops
  waiting, fails or retries the job, and moves on — while the original attempt
  keeps going in the background until it finishes on its own. Laravel's `pcntl`
  alarm does kill it. This is the honest half of that, and it means a timeout
  bounds *the worker's* wait, not the job's work: a job that leaks a connection
  will still leak it after being declared failed.


## @elysian/http — route middleware

**A rate limit checks and then increments, so concurrent requests slip past.**
Four simultaneous calls against `throttle:3,1` all return 200: each reads the
counter before any of them has written to it. `Illuminate\Routing\Middleware\ThrottleRequests`
has the same shape, so this is Laravel's behaviour rather than a divergence, and
the smoke test presses the routes sequentially because that is what a client does.
It matters for a limit meant to stop a burst rather than a rate — an atomic
increment-and-compare in the store is what would fix it.

**Route bindings are declared, not inferred, and that is forced.** Laravel reads
the handler's type hints and needs no registration; TypeScript erases them and
Bun emits no decorator metadata to put them back — the measurement is in the
Limits section below. So `bindings().model('article', Article)` is how a
parameter gets a meaning, which is what Laravel's own `Route::model()` is for
anyway.

Resolution is a middleware rather than automatic, as `SubstituteBindings` is in
Laravel: a route that takes an id and never loads the row should not pay for a
query. It runs after `auth` and `verified` and before `can` — loading a row for
somebody about to be turned away is work for nothing, and `can:update,article`
needs the article already there.

**A scoped binding is resolved through the parent's relation, not the child's
table.** `/articles/{article}/comments/{comment}` finds the comment among *that
article's* comments. Resolved independently, a caller who guessed an id would be
handed somebody else's row by a route that looks like it works. The relation is
named rather than guessed from the parameter — a convention mapping `comment` to
`comments()` breaks on the first irregular plural, and guessing wrong here fails
open.

**Method spoofing happens before routing, and it has to.** Elysia picks a handler
from the method, and a `beforeHandle` hook runs after that choice is already made
— too late to change it. `Request.method` is read-only, so nothing can be edited
in place either. What works is `onRequest`, which runs first: it builds a new
`Request` carrying the real method and hands it back through the router, with a
marker header so the rewritten request is not rewritten again. The plugin is
registered before maintenance mode and CSRF for the same reason — a CSRF check
that ran while the request still claimed to be a `POST` would be checking the
wrong question.

`GET`, `HEAD`, `CONNECT` and `TRACE` cannot be spoofed to, as in Symfony. A POST
turned into a GET is a state-changing request wearing the clothes of a safe,
cacheable one.

**A route's middleware names are read off the hook function, not the route table.**
Elysia compiles a route's `beforeHandle` list into an anonymous chain, so by the
time there is a route table there is nothing to say *which* middleware guards
what — a listing could only report that some does. `middleware()` tags its hook
with `Symbol.for('elysian.middleware.names')`, and Elysia wraps each hook as
`{ fn }` while leaving the function's own properties alone, which is what lets
`route:list` print a column and `middleware:list` count usage. That wrapping is
not a public contract, so both readers come back empty rather than throwing if it
changes. The global symbol is also why `@elysian/console` needs no dependency on
`@elysian/http` to print the column.

**`signed` covers the origin and `signed:relative` does not.** The absolute form
is right for a link in an email and cannot be followed on a host `APP_URL` does
not name — including any ephemeral port, which is why the playground demonstrates
both. Both sides have to agree: the first version shipped the verifier without
the minter, so `signed:relative` was a check nothing could satisfy.

**An `HttpException`'s headers only reach the response once `handleExceptions()`
is wired.** `Application.create()` does it at bootstrap; a test that builds an
application by hand does not, and `Retry-After` goes missing for that reason alone
rather than because the limiter forgot it.


## @elysian/support

**A union of a value and a callback makes a generic class invariant, and the
blast radius is not local.** `search(needle: T | ((item: T) => boolean))` looked
harmless and put `T` in a parameter position the compiler cannot treat
bivariantly, so `Collection<T>` stopped being covariant — and `ModelBuilder<Post>`
stopped being usable as `ModelBuilder<Model>`, which produced **771 type errors
across the model layer and the playground** from one line. Overloads keep the
callback's parameter typed without doing that. The same shape bit `assertJsonPath`
earlier, where `unknown | Fn` silently collapsed to `unknown`; here it is worse,
because it compiles locally and breaks somewhere else.

**`Str.mask` reads a negative length as PHP's `substr` does**, stopping that many
characters from the end rather than masking that many. `mask(card, '*', 4, -4)`
must leave the last four digits — reading it as `Math.abs(length)` masks four
characters and leaves the rest of the card number in the log, which looks
plausible enough to ship.


## Packaging — what `sideEffects` buys

Every package declares `"sideEffects": false`, which is a claim about its
modules and not a setting: nothing in `src/` does anything at import time beyond
declaring. It was checked file by file rather than assumed — the only two
modules that *do* act on import are named instead of hidden by the blanket
claim: `@elysian/concurrency`'s `worker-entry.ts`, which installs
`self.onmessage` and is loaded as a worker, and `create-elysian`'s `index.ts`,
which is a CLI and ends in `process.exit`.

Without the claim a bundler must assume the worst. Measured on Bun 1.3.14,
importing one function — `csrfField` from `@elysian/http` — pulled **498 modules
and 1.1 MB**, because the barrel re-exports the provider and the console
commands, and those reach the console, database, cache and validation packages.
With the claim, the same import is **5 modules**. The playground application
bundles to 509 modules where it was 1355.

None of this changes how the framework runs: a server executes the source, and
every module is loaded anyway. What it changes is the cost to anyone who bundles
— and the cost of importing one helper into something small.

**A bundled application needs its config named.** Reading `config/` — the
default, and right while developing — resolves those imports at run time, so a
bundle loads a *second* copy of the framework through them. The copies do not
share `Application.current`, which is a static, so a config file calling
`storage_path()` as it loads reads an application that does not exist, and the
boot fails somewhere else entirely: `Target [middleware] is not bound`.

`withConfig({ app: () => import('../config/app.ts'), … })` fixes both halves at
once. A literal `import('./x.ts')` is something a bundler can follow, so the
config ends up inside the bundle; and it stays lazy, so it is evaluated after the
application exists. `playground/bootstrap/bundle.ts` is a worked example, and its
base path is `process.cwd()` rather than `import.meta.dir` — inside a bundle that
directory is wherever the bundle was written, not where `storage/` and
`database/` are.

The cost is that a new config file has to be named in that file as well, which is
why it is a second bootstrap rather than the only one.


## @elysian/process

- **Output is text unless you ask for bytes.** `output` is a JavaScript string,
  and a string here is UTF-16: a PNG or a tarball on stdout becomes replacement
  characters on the way in, and the bytes are gone before anybody can ask. PHP
  has no such problem — its strings are byte arrays — which is why Laravel needs
  no equivalent of `binary()`. Ours keeps the raw chunks when asked and answers
  with an empty buffer when not, rather than re-encoding the decoded string,
  which is the round trip that destroyed the data.
- **A command written as a string runs under `sh -c`, on every platform.**
  Symfony picks the operating system's shell — `sh` on Unix, `cmd.exe` on
  Windows — so the same string means different things in different places. This
  picks one, which makes a command string portable and requires a `sh` on the
  PATH under Windows (Git Bash provides one). An array (`run(['git', 'status'])`)
  needs no shell anywhere, and is the form to use for anything built from input.


## @elysian/http-client

**Bun's `fetch` accepts `timeout` and `retry` and silently ignores both.**
Measured on 1.3.12: `fetch(url, { timeout: 200 })` against a three-second handler
returns after 2018ms with a 200, and `{ retry: 5 }` against an endpoint that
fails twice calls it once and hands back the 503. No error, no warning — an
unknown option to `fetch` is discarded. `AbortSignal.timeout()` is the one that
works, and is what this package uses. Two tests pin the ignoring, so the day Bun
implements them the duplication is noticed rather than left in.

What Bun *does* add is real and not reimplementable here: `proxy`, `unix` and
`tls` reach into the runtime's own networking. They are forwarded untouched —
a client that swallowed them would be unusable inside a corporate network.

**Nothing is recorded until something asks.** `recorded()` and the `assertSent`
family read an array the client only fills while `fake()` or `record()` has
turned recording on. Filling it unconditionally looked harmless and is a slow
leak — a server running for a week would keep every outbound request and response
it ever made, and nothing would ever read them. Laravel guards the same array with
the same flag, and `fake()` empties it so an assertion describes the test rather
than the process.

**The default retry policy is narrow, and that is the safety.** A connection
failure, a 429 and 5xx are repeated; everything else is the server saying no on
purpose. Repeating a 422 sends the same invalid body again, and repeating a 401
is how an account gets locked. Widen it per call with the `when` callback rather
than globally.

**A 3xx is not a failure.** `failed()` is 4xx and 5xx only, so `throw()` leaves a
redirect alone — otherwise every caller using `withoutRedirecting()` to read a
`Location` would have to catch.


## @elysian/scheduler

Things worth knowing:

- **`command()` runs in this process, so a slow command holds the minute.**
  There is no second runtime to start and the exit code comes back directly,
  which is the whole reason; the cost is that `schedule:run` is occupied until
  the command returns, and anything else due that minute waits. Laravel spawns,
  and pays a PHP boot per entry instead. `runInBackground()` is the escape hatch
  when a command is long enough to matter.

- **Only a command can run in the background.** A child process is a fresh one
  with nothing to rebuild a closure from — the same wall a queued closure hits —
  so `runInBackground()` on a `call()` entry throws instead of quietly running it
  inline. `schedule().job(...)` is the answer for closure-shaped work: it only
  dispatches, so it returns at once.
- **`schedule:test` ignores maintenance mode on purpose.** `schedule:run` skips due
  entries while the application is down unless they declare
  `evenInMaintenanceMode()`; `schedule:test` exists to run one entry *now*, and
  refusing that during maintenance would remove the only way to check a task before
  bringing the site back.
- **`schedule:run` must be called every minute.** It runs what is due *in that
  minute*; calling it every five minutes silently drops four minutes of entries.
  That is cron's contract, not a limitation added here.
- **The day-of-month/day-of-week rule is POSIX's, not the obvious one.** With both
  fields restricted, an expression matches if **either** matches, so
  `0 0 1 * MON` is "the 1st, and every Monday". `matches()` says so, and there is
  a test for it, because the intuitive reading turns a schedule into one that
  almost never runs.


- **A ping that fails is swallowed.** `pingOnSuccess`, `thenPing` and the rest
  report to a monitor, and monitoring being unreachable must not turn a backup
  that worked into a run that failed. It is also the only reporting a schedule
  can have that survives the schedule not running at all — no hook inside a
  process that is not running can notice its own absence.

### Capturing a scheduled task's output

- **Output is inherited unless something asks for it.** A background task's
  logging then reaches wherever the scheduler's does, rather than disappearing
  into a buffer nobody reads. `sendOutputTo()` and `emailOutputTo()` are what
  turn capture on — for a forked entry by piping the child, for an in-process one
  by patching `console`, which is intrusive enough to do only when asked.
- **A failed run's output is filed too**, and it is the output most worth
  keeping. The console is restored in a `finally`, so a throwing task cannot
  leave the application silent.
- **`emailOutputTo` stays quiet by default when there was no output.** A task
  that succeeds silently every night would otherwise send an empty mail every
  night, and mail nobody reads is mail nobody notices when it matters.

## Artisan — the Laravel commands that have no counterpart

Measured against `ArtisanServiceProvider` in Laravel 13.25.0. What is left after
building everything that applies is not a backlog; each of these is absent
because the thing it operates on does not exist here.

**Caches with nothing to cache.** `route:cache`/`route:clear` — routes are Elysia
instances holding closures, and there is no serialisable form of a route table
whose handlers are functions. `view:cache`/`view:clear` — views are TypeScript
modules; Bun's module cache *is* the compile cache and there is no template
language to compile ahead of time. `event:cache`/`event:clear` — Laravel's exists
to skip reflection when mapping events to listeners, and there is no reflection
here. `clear-compiled` — no compiled container file. `optimize` therefore runs
`config:cache` alone rather than printing four lines of which three are theatre.

**PHP and Composer.** `package:discover` (Composer package auto-discovery),
`vendor:publish`, `config:publish` and `lang:publish` (publishing assets out of a
vendor directory — `stub:publish` is the equivalent for the one thing our
packages actually ship), `invoke-serialized-closure` (Opis closures over the
wire, a Vapor internal), `make:trait` (no TypeScript equivalent), `docs`.

**Owned by something else.** `clear-resets` — better-auth owns the password reset
table and expires its own tokens. `cache:prune-stale-tags` — tags here are a
namespace built from per-tag ids, so flushing a tag is giving it a new id and the
orphaned entries expire on their own TTL; there is no tag index to go stale.
`schedule:finish` — Laravel's callback for a background task reporting
completion, not a command anybody runs.

**The same thing under one name.** `queue:prune-failed` is `queue:flush --hours`.
`make:console` is `make:command`. `model:prune` is Laravel's `db:prune` class.
`event:generate` generates from an event-to-listener map that does not exist
here; listeners are discovered from `app/Listeners`.


## @elysian/mail

Three behaviours worth knowing:

- **SES is signed here, not by an SDK.** `sigv4.ts` passes AWS's own published
  test vectors, which are committed under `packages/mail/test/fixtures/sigv4`.
  One of them — `post-x-www-form-urlencoded` — has files that disagree with each
  other, so only its canonical request is asserted; the reason is in the test.
- **`alwaysTo` keeps the originals.** Redirected recipients are written to
  `X-Elysian-To`/`Cc`/`Bcc` rather than dropped, so a message caught on staging can
  still be traced to who it was for.
- **`allowSelfSigned` is refused in production.** The flag exists for a local mail
  catcher; the manager throws rather than honour it where it would mean mail
  readable in transit.


## @elysian/mail

- **A built message does not remember which disk an attachment came from.**
  `attachFromDisk` resolves the file to bytes while the message is built, on
  purpose: a queued message must not depend on the disk still holding the file an
  hour later. So Laravel's `assertHasAttachmentFromStorageDisk` has no equivalent
  — `assertHasAttachment(filename)` and `assertHasAttachedData` are what is left,
  and they check what actually travels.
- **`assertSeeInHtml` escapes its needle by default.** The view wrote
  `O&#39;Brien`, so a raw search for `O'Brien` finds nothing in a message that is
  perfectly correct. Pass `false` as the second argument to search the markup
  itself.


## @elysian/storage

Four behaviours worth knowing:

- **MinIO does not implement per-object ACLs**, so the tests for them skip
  against it rather than fail: `GET ?acl` answers with a canned
  owner-`FULL_CONTROL` document whatever was written, and `PUT ?acl` returns 200
  and changes nothing. Its model is bucket policies. The rest of the S3 suite
  runs against it unchanged.
- **A bucket that refuses `GetObjectAcl` reports the disk's default.** Buckets
  with ACLs disabled entirely (`BucketOwnerEnforced`) are the common modern
  setup, and there the permission is not missing — the concept is. Throwing would
  make visibility unusable rather than merely unknown.
- **A path that leaves the disk is refused, not rewritten.** `../../.env`,
  `/etc/passwd` and a `..` that walks out through a symlink all throw
  `PathOutsideDiskError`. Stripping the segments instead would silently turn a
  hostile path into a valid one. There are tests for each, and one that confirms a
  `..` which *stays* inside is still allowed.
- **A missing file reads as `null`; an unreadable directory throws.** The
  distinction is deliberate: a directory nobody has written to yet is a normal
  state, but one that exists and cannot be read is a misconfiguration that should
  not look like "empty".
- **`Content-Disposition` is built defensively.** Quotes, backslashes, CR and LF
  are removed from the filename before it goes in, so a filename cannot close the
  quoted string or split the header; the real name travels in `filename*`.


## @elysian/translation

- **A missing key comes back as the key.** An untranslated page shows
  `orders.title` — obviously wrong, obviously fixable — where an empty string
  shows a page that looks finished and says nothing. `whenMissing()` is the hook
  for finding them in bulk: log them, count them, or fail a test run that
  introduced one, since a missing translation is invisible in a language nobody
  on the team reads.
- **A sentence can be its own key.** `lang/id.json` translates whole strings —
  `__('You have no orders yet.')` — beside the dotted keys in `lang/id/`. Both
  shapes live in the same directory and are consulted sentence-first. The reason
  Laravel has both is that inventing a key for every string is what stops people
  translating anything, and a sentence key still reads correctly untranslated.


## @elysian/notifications

Two things to know about language:

- **A queued notification resolves its language before it is queued.** The
  worker gets a rebuilt stand-in for the recipient, not the model — there is no
  `preferredLocale()` left to ask — so the locale travels in the payload and the
  job switches the translator around the delivery. Without that, the same
  notification came out in the recipient's language when sent in the request and
  in the process default when sent by a worker.
- **`inLocale()` outranks the recipient's preference.** The preference is the
  right default and not always right: an alert an operations team reads in one
  language, or a receipt copied to an accounts mailbox, is about the
  notification rather than about the person.

And three more:

- **The id belongs to the delivery, not to the notification object.** Each recipient
  gets its own uuid, shared by every channel it is sent through — that is what lets
  a stored row and the mail about it be correlated. Laravel gets this by cloning the
  notification per recipient; we share one instance, so the id is assigned per
  recipient explicitly. Writing the test for it is what caught the first draft
  handing recipient two the id of recipient one.
- **A failing channel re-throws.** The event is dispatched first, but the error is
  not swallowed: a queued notification that failed silently is a notification
  nobody knows was lost.
- **`database` is skipped for an on-demand recipient.** There is no record for the
  row to belong to, and `route('database', …)` refuses outright rather than writing
  an orphan.


## @elysian/encryption

Decisions worth knowing rather than discovering:

- **One AEAD does both jobs.** GCM encrypts and authenticates in one pass, so
  there is no separate MAC to compare and no order-of-operations mistake to make.
  `node:crypto` in Bun enforces the tag, and it is synchronous, so encryption is
  not an `await` in the middle of an accessor.
- **Keys are derived, never used raw.** HKDF with a purpose string means the cookie
  *signer* and the *encrypter* never share key material, even though both come from
  `APP_KEY`. Compromising one does not hand over the other.
- **Context is authenticated, not carried.** `encrypt(value, 'cookie:remember')`
  binds the purpose into the tag: the payload does not grow, the context does not
  leak, and lifting a value from one cookie into another fails to decrypt rather
  than merely looking odd. This is what Laravel's HMAC-of-the-cookie-name prefix
  buys, without the bytes or the stripping.
- **Every failure reads the same.** A caller is told "Could not decrypt the
  payload." whether the version, the length, the tag, the context or the key was
  wrong. Distinguishing them is how a padding-oracle-shaped attack starts.
- **`session.encrypt` without the provider warns.** The cookie falls back to being
  signed rather than failing the boot, but it says so through the log: silently
  degrading would leave somebody believing a cookie is encrypted when it is not.
- **No key accessors, on purpose.** Laravel's encrypter hands out `getKey()`,
  `getAllKeys()` and `getPreviousKeys()`; this one exposes only `keyCount`. Key
  material on a service that every controller, job and model can reach is one
  `dd($crypt)` or one serialised exception away from being written somewhere it
  is read later, and the two things applications actually want it for both have
  better answers: `deriveKey(APP_KEY, purpose)` for an application's own key, and
  `usesCurrentKey()` for the rotation question. `supported()` is absent for a
  different reason — it asks whether a key is the right length for a cipher, and
  ours is derived to the right length from any secret, so the answer is always
  yes.
- **`encryption:rotate` skips what is already current.** Re-encrypting a row that
  the current key can already read costs a decrypt, an encrypt and an UPDATE to
  arrive at the same value under a different nonce. On a table rotated once
  before — the normal case, since rotation happens more than once — that is most
  of the table, which is the difference between a minute and an hour. `--force`
  rewrites regardless, for the day the payload *format* changes rather than the
  key. Rows that no configured key can read are never touched and always
  reported: overwriting one would destroy data, and it is the operator who knows
  whether it is a lost key or a column that was never encrypted.
- **Encrypting a column costs you querying it.** `where('editor_note', …)` cannot
  match a ciphertext, and no amount of care changes that — a fresh nonce per write
  means the same plaintext never produces the same bytes twice. Encrypt what you
  read, not what you search by.


## @elysian/broadcasting

- **A presence channel authorises and identifies in one answer.** What the
  callback returns *is* what the other members are told, so everything on the
  member list is something the server chose to publish — a channel that leaked an
  address would have had to name `email`. Returning nothing refuses.
- **`here` includes the joiner; `joined` does not go to them.** That is Echo's
  contract, and any client written for Laravel already expects it. The other
  arrangement — a list without yourself, plus your own arrival — makes a client
  render itself twice.
- **One person with two tabs is one member and one arrival.** Membership is
  tracked per socket and reported per person, so the second tab announces
  nothing and closing it announces nothing; the `left` event waits for the last
  socket. Otherwise closing one tab tells everybody you went away while you are
  still there.
- **On `redis`, a process does not deliver to its own sockets first.** Every
  broadcast is published to the bus, and the publishing process is served when
  the message comes back round with everybody else's. That is Reverb's
  arrangement and the reason is ordering: one path means every process sees the
  same sequence, where a local delivery ahead of the publish would let one
  process order its own events differently from the rest. It also means
  `broadcast()` answers `0` on `redis` — at that point nothing has been written
  to a socket, and how many sockets the other processes hold is not knowable from
  here.
- **The excluded socket travels with the message.** `toOthers()` names a socket
  id, and that socket lives in exactly one process; every other process looks for
  it, finds nothing, and delivers to everyone — which is the correct answer
  there, not a case to resolve before publishing.
- **A failed publish is swallowed.** A broadcast was never a delivery guarantee,
  and a Redis that is down must not take down the request that caused the event.
  What is lost is the other processes hearing it, which is the same outcome as
  having no bus at all.
- **A member list is gathered, not stored.** Membership lives in each process's
  memory — there is no shared registry, and Reverb has none either — so "who is
  on this channel" is a question put to every process rather than a lookup:
  publish the request, learn from the publish how many heard it, merge the
  replies. `presenceAcross()` is that; `presence()` still answers for this
  process alone, which is what the join and leave events need.
- **A gather ends on the last reply, or on half a second.** The count Redis
  returns from `PUBLISH` is how it knows when every process has answered, so the
  usual case costs one round trip. The timeout only matters when a process has
  died without Redis noticing, and then a partial list beats a socket that never
  receives one. Reverb allows ten seconds for the same gather over its HTTP API;
  this one runs inside a subscribe, where somebody is waiting.
- **An event broadcasts itself by having `broadcastOn()`.** There is no interface
  to implement, because TypeScript erases interfaces and a marker nothing can
  check at runtime is not a marker. `broadcastAs()` and `broadcastWith()` are
  optional and default to the class name and the event's own fields — which is
  usually right and exactly what you do not want when one of those fields is a
  model or a secret.


## @elysian/view — what Blade's directives became

Most of Blade's directive set is a workaround for PHP-in-HTML that TSX makes
unnecessary, and the mapping is worth stating once so the absence does not read
as a gap. `@if` is a ternary, `@foreach` is `.map()`, `@include` is a component,
`@checked`/`@selected`/`@disabled` are ordinary boolean attributes, `@props` is a
parameter list, and `{{ }}`'s escaping is the `safe` attribute. `@lang`/`@choice`
are `__()`/`choice()`; `@inject` is `app()`; `@csrf`/`@method` are `csrfField()`
and `methodField()`.

What is left is the handful where the *string being built* needs rules of its
own, and those are functions here: `whenError`, `whenAuth`, `whenGuest`,
`whenCan` for what a page cannot see from its props; `stack`/`push`/`prepend`/
`once`/`pushOnce` for writing into a layout that already rendered; and
`classes`/`styles`/`json` for attributes and embedded data.

`json()` is the one with teeth. Inside a `<script>` the parser is looking for the
literal `</script`, so a value containing one closes the block early and
everything after it is markup again — a working XSS through a field that never
touched the HTML escaper. `JSON.stringify` has no reason to care, which is why
this is a helper rather than an instruction to remember.

`$loop` has no counterpart and does not need one: `.map((item, index, all) =>
…)` already carries the index and the array, so `first`, `last` and `count` are
each one expression. Blade needs `$loop` because its `foreach` hands over neither.


## What a scaffolded application ships

Measured against `laravel new` and the official starter kits, file by file. Most
of the difference was ours to close and is now closed; what is left is
deliberate.

- **A frontend build.** `vite.config.ts`, `resources/js/app.ts`,
  `resources/css/app.css`, and `bun run build` / `bun run dev:assets`. The hot
  file is written by a plugin in the config rather than by a dependency —
  Laravel's `laravel-vite-plugin` does the same few lines. The config exports a
  plain object rather than going through `defineConfig`, so `bun run typecheck`
  works before the front-end dependencies are installed.
- **`vite()` is loud in production and quiet elsewhere**, which is a departure:
  Laravel's `Vite` throws `ViteManifestNotFoundException` in every environment.
  It can, because `laravel new` runs the asset build while installing, so its
  first boot always has a manifest; this scaffolder cannot, since the front-end
  packages are installed when the developer asks. A 500 on the landing page
  before anybody has run anything is a poor first minute, so outside production
  it warns once, names the fix, and renders no tags.
- **The manifest is looked for in two places.** `build/manifest.json` is where
  Laravel looks and where `laravel-vite-plugin` puts it — it sets `manifest:
  'manifest.json'`, and this template does the same. Vite 5's default is
  `.vite/manifest.json`, so a project that only set `manifest: true` has it
  there; falling back costs one `existsSync`. Found by running the build rather
  than by reading the config: the template said `manifest: true` and the page
  came out with no assets at all.
- **`routes/console.ts`**, loaded by `withConsole()` rather than `withRoutes()`:
  it registers schedules and commands and mounts nothing, so it has no default
  export to mount. Laravel reaches the same file through `withRouting(console:)`.
- **`config/services.ts`**, `.editorconfig`, `.gitattributes` — the last of these
  for the reason this repository learned the hard way: a checkout on Windows
  arrives with CRLF and every file reads as unformatted.
- **Storage directories exist**, each with the `.gitignore` that keeps its
  contents out and itself in.

**Tests are split as Laravel splits them** — `tests/Feature` for the ones that
boot the application, `tests/Unit` for the ones that do not. The two have very
different costs, and being able to run the fast half alone is the difference
between a suite you run on every save and one you run before pushing.

What is still deliberately different, and why:

- **No migrations.** Laravel ships three because its defaults put session, cache
  and the queue in the database. Ours default to `file`, `file` and `sync`, so a
  new application needs no table at all on day one; `cache:table`, `queue:table`
  and `session:table` write them when you move. The users table is better-auth's
  and depends on `config/auth.ts`, so `auth:schema` generates it.
- **No `app/Models/User` in the base template.** The table does not exist until
  an auth kit has been chosen and `auth:schema` has run, and a model pointing at
  a table that is not there is a lie the first time anybody queries it. Both auth
  kits ship one.
- **Providers are listed in `config/app.ts`**, where Laravel 11 moved them out to
  `bootstrap/providers.php`; and a controller is `controller('name')` rather than
  a class extending a base `Controller`.
- **No `phpunit.xml` equivalent.** `bun test` needs no configuration file.


## @elysian/auth — what an application declares about itself

Two things the framework cannot know: which endpoints better-auth exposes, and
what a user row holds. Both depend on `config/auth.ts` — its plugins and the
schema `auth:schema` generated from them — so an application says them once, by
declaration merging, beside the config they come from:

```ts
declare module '@elysian/auth' {
  interface AuthTypes {
    api: Auth<typeof config>['api']
    user: { id: string; name: string; email: string; emailVerified: boolean }
  }
}
```

`api()` and `userOf()` are typed from that everywhere else, with no cast at any
call site and no helper file in the application.

- **`AuthTypes` is empty on purpose.** An interface with members cannot have them
  replaced by merging — TypeScript refuses a second declaration with a different
  type — so the defaults are conditional (`AuthTypes extends { api: infer A } ? A
  : …`) rather than declared. Without the declaration, `api()` is `getSession`
  and nothing else, which is all the framework itself uses.
- **`Auth<typeof config>` is better-auth's own inference**, not a claim: it
  returns `Auth<Options>` from `betterAuth(options)`. The kits used to carry a
  hand-written list of endpoint signatures, which typechecked and still accepted
  calls to endpoints whose plugin was not enabled.


## The starter kits

Two, and they are different *shapes* of application rather than two takes on the
same one — which is the only reason a second kit is worth its weight.

- **`auth`** is server-rendered: sessions, cookies, CSRF, and pages. Nine
  controllers under `Auth/` and `Settings/`, none over 130 lines, over a shared
  `app/Support/auth.ts`; the pages are grouped the same way, `views/pages/auth/`
  and `views/pages/settings/`, and the tests are `tests/Feature/Auth/` and
  `tests/Feature/Settings/`. It began as one controller of 619 lines and nineteen
  routes.

  The arrangement is Laravel's, checked against the React starter kit rather than
  guessed: it keeps `Settings/ProfileController` and `Settings/SecurityController`
  in a directory of their own, groups its auth pages under `pages/auth/`, and
  splits its tests into `Feature/Auth` and `Feature/Settings`. What it does *not*
  have is our auth controllers at all — Fortify owns those routes there. This
  framework has no Fortify, so the kit owns them, grouped the way Laravel groups
  what it does own. Its flows are
  driven over HTTP in the smoke run, inbox included: a reset link is read out of
  the log the `log` mailer writes to, followed to the form, used once, and refused
  the second time.
- **`api`** has no views at all. Identity is better-auth's session token, handed
  out through the `bearer` plugin's `set-auth-token` header and sent back as
  `Authorization: Bearer …`. There is no second identity table and no second
  notion of a session; a personal-access-token store — Sanctum's shape — is a
  different feature this kit deliberately does not invent.

Two things the API kit proves about the framework rather than about itself:
**a guest gets 401 and not a redirect**, because the exception handler reads
`Accept` and the kit has no sign-in page to be sent to; and **`/api/*` is outside
CSRF**, which the base template already configured — that check exists for a
browser sending cookies unasked, and a bearer token is never sent that way.

A kit is a folder copied over the template rather than a fork of it, so anything
a kit does not mention it inherits and the two cannot drift. The API kit mentions
four files: its controller, a `config/auth.ts` that differs from the template's by
one line, and its two test files.

**A scaffolded application arrives with tests.** The template ships a feature
test and a unit test; each kit ships tests for the flows it scaffolds — written
the way the application's author would write them, since they are the author's
now. Laravel does the same, and for the same reason: `@elysian/testing` was in
every scaffolded `package.json` and no scaffolded file used it, which is the
shape of every "we have that feature" that turns out not to work.

They are stored under names with no `.test.` in them — `_example.ts` becomes
`tests/example.test.ts` on copy — because this repository's own `bun test` would
otherwise find them, and they import a `bootstrap/app.ts` that only exists once
scaffolded. The same rename mechanism already carries `_package.json`.

**The tests use a database of their own**, built from the real migrations on
first run: `tests/database.ts`, which any test that touches the database imports.
The kits' copy adds one thing — a clear error when better-auth's tables have not
been generated yet, since `auth:schema` writes a migration that depends on
`config/auth.ts` and cannot be shipped.


## create-elysian

**The kit is now proven, not merely scaffolded.** Every earlier check on the auth
kit asserted that files landed and that a string appears in `routes/web.ts`. A
kit whose controller threw on its first request would have passed all of them.
The smoke run now writes the scaffold an environment, runs `auth:schema` and
`migrate`, serves it on a socket in its own process, and walks the cycle over
HTTP: the sign-in page renders, a guest is turned away from the dashboard,
registering redirects with a session cookie, the dashboard greets that user by
name, a duplicate address and a wrong password both go back to their form, and —
the one worth having — the cookie stops opening the dashboard after sign-out
rather than merely being cleared in the browser.


One thing worth knowing, and two worth remembering:

- **No migrations ship in the box.** Laravel's skeleton carries `users`, `cache`
  and `jobs`; better-auth's tables depend on `config/auth.ts`, so they are
  generated with `auth:schema`, and the rest are only needed when a driver changes.
  `create-elysian` prints those steps rather than assuming them.

- **The template drifted for eight packages and nothing noticed.** Every package
  was exercised by the playground, where the wiring was written by hand, so a new
  application silently lacked half the framework while every test passed. Its
  `config/session.ts` also told a new application that cookies are signed "rather
  than encrypted" long after that stopped being true.
- **What catches it now is registration.** The smoke run boots a scaffolded
  application and asserts that a command from each package appears in `artisan
  list` — a command only appears if its provider booted, which needs the
  dependency, the provider entry and the config file all present. A ninth package
  that forgets the template fails there.


## What boot costs, and what to do about it

**A quarter of a second of that four seconds is the application.** The auth kit
boots in 4005 ms, of which 3761 ms is Bun loading and transpiling modules and
244 ms is config, provider registration, boot, and routes. There is no cache
between processes: `BUN_RUNTIME_TRANSPILER_CACHE_PATH` holds only files above
50 KB, and a framework of small modules has almost none — measured with it set,
the cache took ten entries and the boot did not move.

This is why there is no `DeferrableProvider` here. Laravel defers `Mail`,
`Cache`, `Queue`, `Validation`, `Broadcasting`, `Translation` and `Hashing`, and
porting that would have bought some fraction of those 244 ms, against a container
that resolves bindings by loading packages and a rule that a deferred provider's
`register()` may not be async. The measurement is what decided against it.

**Bundling is the cache PHP gets for free.**

    plain   2047 ms from source     221 ms bundled
    auth    4005 ms from source     535 ms bundled
    artisan list    4.019 s from source    0.604 s bundled

So `artisan app:build` writes `dist/artisan.js`, `optimize` runs it, and
`artisan.ts` hands over to that bundle when it is newer than every source file.
Nothing happens until somebody builds one, and any edit makes it stale — a fast
path that is used without being opted into is a fast path that eventually runs
yesterday's code.

**`bun --hot` looks like the answer and silently is not.** The process stays up,
the routes do not change: a handler edited under `--hot` keeps answering with the
old body, indefinitely, with no error and no reload line in the log. Elysia
builds its route table once at boot, and re-evaluating a module does not rewire a
server that is already listening. `--watch` restarts the process instead and
picks the change up in 2676 ms, which is why `bun run dev` uses it.


## Limits

Not gaps — nothing here is waiting to be built. These are the places the
framework stops, and the reasons are the useful part.

**A file's visibility is a POSIX mode, so it does not exist on Windows.** The
local disk writes `public` as `0o644` and `private` as `0o600`, and reads
visibility back off the mode. Windows has no such mode: `chmod` there toggles one
read-only bit, so a file written `private` reads back `public` and a directory set
to `0o000` stays readable. The disk does not pretend otherwise and the tests for
it skip rather than assert something weaker. The S3 disk carries visibility in the
object's ACL and is unaffected; so is everything else the local disk does.

**MySQL is unusable from Bun on Windows.** Not slow — it stops. The dialect suite
reaches the MySQL block and produces nothing further; the process never prints a
summary and never exits. The same file, the same servers, the same Bun 1.3.14,
run from WSL Linux: **121 tests in 6 seconds**.

It took a day to establish that, so here is what was ruled out, each measured
rather than assumed. MySQL **8.4** and **9.7.1** both hang. Bun **1.3.3** and
**1.3.14** both hang. Pool size **10** and **1** both hang. The DDL the grammar
emits is valid. Both query paths — `statement()` through Bun's prepared path and
`unprepared()` through the simple one — are fast. Connecting, creating, dropping,
reading, writing and disconnecting are all milliseconds in isolation; sixty
connect/disconnect cycles and fifteen create/drop cycles pass without
degradation. Postgres, SQLite and Redis are fine on Windows.

Bun's own tracker carries a family of MySQL-only hangs — #26030, #26235, #26237,
#26048, #29271, #22695 — closed, reopened, closed again, and one still open on
Windows (#24130). Postgres appears in none of them.

**So: develop on Linux, WSL, or macOS if the application uses MySQL.** WSL with
mirrored networking reaches a MySQL running on the Windows host at `127.0.0.1`
unchanged, which is the cheapest way out — no config edit, no second server.

**`expect(promise).rejects` never settles on Windows when the promise came from a
networked driver.** A rejection produced after a Postgres, MySQL or Redis round
trip — `await expect(cache.integer('name')).rejects.toThrow(...)` — hangs for
ever. Bun then reports "a beforeEach/afterEach hook timed out for this test",
which sends you to the hooks; those measure 0–1 ms.

Reproduced on Bun 1.3.3 and 1.3.14, so it is not a version regression, and the
same file passes on macOS. **SQLite is unaffected** — `migrator.test.ts` uses
`.rejects` throughout and passes — as is a plain
`expect(Promise.reject(...)).rejects`. The socket is what makes the difference.

Catch the rejection instead, which asserts the same thing and cannot hang:

```ts
const refused = await cache.integer('name').catch((error: unknown) => error)

expect(refused).toBeInstanceOf(TypeError)
```

The symptom is the expensive part: no output at all, because Bun buffers a file's
results until the file finishes and writes the per-test `✓` lines only to a
terminal. A run that looks frozen may be one hung assertion, or may simply be
slow — `bun test <file> > out.txt` shows nothing either way.

**A Bun SQL connection is a pool, not a socket.** `new SQL(...)` opens ten by
default — measured at eleven including the one asking. Anything that counts
server-side connections has to allow for that, or it reports its own pool as
somebody else's leak; `scripts/flush-connections.ts` passes `max: 1` for exactly
that reason. `sql.close()` does close the whole pool, on both platforms.

**Connections carry a 30-second timeout by default.** Bun sets none, and a
connection that never completes then produces no error at all — the query waits,
the process will not exit, and nothing says why. `DB_CONNECT_TIMEOUT` changes it
per application.

**Bun has no image API at all.** No `createImageBitmap`, no `OffscreenCanvas`,
nothing native — checked directly on 1.3.12. So `@elysian/image` is two halves.
`probe()` reads format and dimensions out of the bytes in pure TypeScript for
png, jpeg, gif, webp, bmp, tiff, avif and heic, needs nothing installed, and
covers the check most applications actually want, since a file extension and a
client's `content-type` are claims and the header is the file. Transforming needs
a backend that is looked for rather than assumed — `sharp` if the application
installed it, ImageMagick if the machine has it, `sips` on macOS — and a driver
that cannot perform a queued step raises an error rather than skipping it. Only
ImageMagick and `sharp` can blur, sharpen or greyscale; `sips` cannot, and says
so through `supports()`.

**A function cannot be sent to a worker, and the reason is worse than "closures
do not travel".** `Function.prototype.toString()` gives the body without the
scope, which is the expected half. The other half is that Bun's transpiler
*inlines a captured `const` primitive into the source*: `const name = 'ada'`
followed by `() => name.toUpperCase()` stringifies as
`() => "ada".toUpperCase()` and works in a worker, while the identical code
written with `let` stringifies as `() => name.toUpperCase()` and throws
`ReferenceError`. A feature whose success depends on which keyword declared a
variable is a trap, so `WorkerDriver` refuses a function outright and asks for
`{ module, export, args }`. `SyncDriver` accepts one, because nothing crosses a
boundary there — which also makes `sync` a poor rehearsal for `worker`.

**Laravel's `Reflection` component cannot be written here.**
`Reflector` exists to read a constructor's parameter *types* and resolve each one
from the container. TypeScript erases those types, and nothing puts them back:
`Reflect.getMetadata('design:paramtypes', …)` is `undefined` under Bun even with
`experimentalDecorators` and `emitDecoratorMetadata` both switched on, because
Bun does not emit the metadata that NestJS-style autowiring depends on. Checked
directly rather than assumed, on Bun 1.3.12 and TypeScript 7.0.2. The container
here resolves by token instead, which is a deliberate choice and not a
workaround — copying the reflective approach would mean asking every application
to carry a metadata polyfill so the framework could guess what a token already
says outright.

**Compile-time XSS checking was attempted and is blocked.**
`@kitajs/ts-html-plugin`'s CLI reads `typescript.sys`, which TypeScript 7 removed
from the default export, so it crashes under both Bun and Node. `safe` remains a
runtime guarantee and a review responsibility. This is the one thing that was
tried and could not be made to work, as opposed to deliberately left out.

Two things that are correct today and will not always be:

- **`sessions.last_activity` is a 32-bit integer**, like Laravel's. It holds a
  unix timestamp, so it is correct until 2038 and then it is not — the same shape
  as the cache's `expiration` bug that Postgres and MySQL caught. Left alone
  because nothing writes a value beyond the range today; worth widening the next
  time that table changes.
- `node_modules/.bun` holds **two copies of elysia 1.4.29** under different peer
  hashes. Nothing misbehaves today, but dual module identity is exactly what the
  `file:`-dependency episode was about, and Elysia deduplicates plugins by name
  within one module instance. Worth collapsing if plugin registration ever gets
  strange.

### What the tests do not reach

`bun test --coverage` reports roughly three quarters of functions. Known
uncovered, and why:

- terminal formatting (`output.ts`, `about.ts`, `db:show`, `db:table`) — the
  smoke test asserts the text that matters; pinning colour codes would test
  `picocolors`
- `serve.ts` — its `handle()` never resolves by design; the smoke test binds a
  real socket instead
- `create-elysian` — covered end to end by the smoke test rather than by units:
  it scaffolds, boots, and every package's commands are registered in what it
  wrote. Not covered is a scaffold installed *from npm* rather than resolved
  through the workspace
- MySQL/Postgres **grammar** paths that the dialect suite does not reach, such as
  `insertGetId` on MariaDB
- the S3 disk against AWS itself — the round trip is covered against MinIO
  (`TEST_S3_ENDPOINT`), which is the same protocol, but not against S3's own
  eventual-consistency and region behaviour
- the `sqs` driver against AWS itself — the round trip is covered against
  ElasticMQ, which speaks the same query protocol and the same SigV4, but not
  against AWS's own eventual consistency, its 120,000 in-flight limit, or FIFO
  queues
- the queue's `redis` driver against a cluster; single-node Redis is covered, and
  the database driver is covered on SQLite, Postgres 17 and MySQL 9 including the
  two-workers-race case that only a real server can exercise
- better-auth **plugin** schemas against real servers — the adapter itself is
  covered on SQLite, Postgres 17 and MySQL 9 by `packages/auth/test/dialects.test.ts`,
  but only for the four core tables
