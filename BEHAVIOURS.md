# Behaviours worth knowing

Why some things here work the way they do — the decisions that are easy to
misread from the outside, and the failures that led to them.

Everything below is behaviour that already exists and would otherwise have to be
rediscovered — through a bug, usually, since none of it can be read back off the
code. The code says what happens; this says why.

It had a companion, `GAPS.md`, holding what was still missing. Four of them have
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


## @elvel/database — complete for this milestone

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
  and a running `elvel serve` able to share a file at all. `journalMode:
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


## @elvel/events

Four things to know about a queued listener:

- **It is a class, not a closure.** A worker is a different process, so only a name
  travels — the same constraint jobs have. `QueuedListener` is what a worker can
  resolve; anything in `app/Listeners` is discovered, and `elvel make:listener X
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


## @elvel/validation

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


## @elvel/http

- **`app.handle()` needs a URL at least 12 characters long before the path.**
  Elysia slices the path out of `request.url` at a fixed offset, so
  `new Request('http://x/thing')` routes to nothing and answers 404 while
  `http://localhost/thing` works. `@elvel/testing` uses `http://localhost` and
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
- **Silence means opposite things to validation and to a redirect**, and that is
  deliberate. A request with no `Accept` header at all is read as a client by
  `FormRequest` — no browser omits it — and as a browser by `Redirect`, which is
  Laravel's own reading. What is at stake decides it: a `Request` built without
  headers is a test, an internal dispatch or a health probe, and reading those as
  clients turned 29 redirects into JSON payloads nobody followed. The rule lives in
  one place, `negotiation.ts`, with the difference passed in as `whenSilent`.
- **A hand-built redirect negotiates too.** `fetch` follows a 302 silently and lands
  on a document whose flash it never renders, so the form comes back blank with
  nothing said — which is why `redirect().withErrors(...)` answers a JSON caller 422
  `{ message, errors }` instead. On that 422 the flash is skipped rather than merely
  unused: left behind, it lights up whatever form a later navigation happens to
  reach.
- **On the success answer, the flashes are written after all** — and the first
  version got this backwards. It skipped them for every JSON caller, reasoning that
  a client renders no document. But `{ redirect }` *means* the client is about to
  fetch one, and that document is what consumes the flash. What it broke: enrolling
  a second factor, where the POST flashes the TOTP secret and ten recovery codes and
  the page it redirects to is the only place they are ever shown. The page arrived
  with no enrolment on it and no error either. Found by clicking "Set up two-factor"
  in a browser, not by reading.
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


## @elvel/auth

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


## @elvel/cache

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


## @elvel/queue

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


## @elvel/http — route middleware

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
with `Symbol.for('elvel.middleware.names')`, and Elysia wraps each hook as
`{ fn }` while leaving the function's own properties alone, which is what lets
`route:list` print a column and `middleware:list` count usage. That wrapping is
not a public contract, so both readers come back empty rather than throwing if it
changes. The global symbol is also why `@elvel/console` needs no dependency on
`@elvel/http` to print the column.

**`signed` covers the origin and `signed:relative` does not.** The absolute form
is right for a link in an email and cannot be followed on a host `APP_URL` does
not name — including any ephemeral port, which is why the playground demonstrates
both. Both sides have to agree: the first version shipped the verifier without
the minter, so `signed:relative` was a check nothing could satisfy.

**An `HttpException`'s headers only reach the response once `handleExceptions()`
is wired.** `Application.create()` does it at bootstrap; a test that builds an
application by hand does not, and `Retry-After` goes missing for that reason alone
rather than because the limiter forgot it.


## @elvel/support

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
claim: `@elvel/concurrency`'s `worker-entry.ts`, which installs
`self.onmessage` and is loaded as a worker, and `create-elvel`'s `index.ts`,
which is a CLI and ends in `process.exit`.

Without the claim a bundler must assume the worst. Measured on Bun 1.3.14,
importing one function — `csrfField` from `@elvel/http` — pulled **498 modules
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


## @elvel/process

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


## @elvel/http-client

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


## @elvel/scheduler

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

## The CLI — the Laravel commands that have no counterpart

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


## @elvel/mail

Three behaviours worth knowing:

- **SES is signed here, not by an SDK.** `sigv4.ts` passes AWS's own published
  test vectors, which are committed under `packages/mail/test/fixtures/sigv4`.
  One of them — `post-x-www-form-urlencoded` — has files that disagree with each
  other, so only its canonical request is asserted; the reason is in the test.
- **`alwaysTo` keeps the originals.** Redirected recipients are written to
  `X-Elvel-To`/`Cc`/`Bcc` rather than dropped, so a message caught on staging can
  still be traced to who it was for.
- **`allowSelfSigned` is refused in production.** The flag exists for a local mail
  catcher; the manager throws rather than honour it where it would mean mail
  readable in transit.


## @elvel/mail

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


## @elvel/storage

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


## @elvel/translation

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


## @elvel/notifications

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


## @elvel/encryption

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


## @elvel/broadcasting

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


## @elvel/view — what Blade's directives became

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

- **`sessions.last_activity` is 64-bit, where Laravel's is 32.** The column holds
  seconds, so a 32-bit one stops working in January 2038 — and this table's whole
  job is to be swept by comparing against that column. It is not a distant
  problem in the way it sounds: Postgres refuses an `integer` insert above `2^31`
  outright, so the failure arrives as sessions that cannot be written, on a
  machine whose clock is merely wrong. The cache's `expiration` column was the
  same shape and was caught by a test rather than by a date; this one was widened
  before it could be, and `session-dialects.test.ts` holds it there against real
  Postgres and MySQL — SQLite cannot answer the question, because it stores
  integers dynamically and a 32-bit *declaration* holds a 2040 timestamp there
  perfectly well.

  An application scaffolded before this only gets it by running the change
  itself; a stub is copied once, not applied twice:

  ```sql
  -- postgres
  alter table sessions alter column last_activity type bigint;
  -- mysql
  alter table sessions modify last_activity bigint not null;
  -- sqlite needs nothing: it never stored the width
  ```
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


## @elvel/auth — what an application declares about itself

Two things the framework cannot know: which endpoints better-auth exposes, and
what a user row holds. Both depend on `config/auth.ts` — its plugins and the
schema `auth:schema` generated from them — so an application says them once, by
declaration merging, beside the config they come from:

```ts
declare module '@elvel/auth' {
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
- **`api`** has no *pages* — one welcome view and its layout, and nothing else;
  it gained those the day every kit with views gained a welcome screen, and the
  claim here said "no views at all" until writing the documentation caught it.
  Identity is better-auth's session token, handed
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
now. Laravel does the same, and for the same reason: `@elvel/testing` was in
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


## create-elvel

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
  `create-elvel` prints those steps rather than assuming them.

- **The template drifted for eight packages and nothing noticed.** Every package
  was exercised by the playground, where the wiring was written by hand, so a new
  application silently lacked half the framework while every test passed. Its
  `config/session.ts` also told a new application that cookies are signed "rather
  than encrypted" long after that stopped being true.
- **What catches it now is registration.** The smoke run boots a scaffolded
  application and asserts that a command from each package appears in `elvel
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
    elvel list    4.019 s from source    0.604 s bundled

So `elvel app:build` writes `dist/elvel.js`, `optimize` runs it, and
`elvel.ts` hands over to that bundle when it is newer than every source file.
Nothing happens until somebody builds one, and any edit makes it stale — a fast
path that is used without being opted into is a fast path that eventually runs
yesterday's code.

Re-measured on Bun 1.4, on Windows, on the auth kit:

    elvel list    0.580 s from source    0.337 s bundled

Still worth having, and no longer the difference it was — Bun got most of the way
there on its own. The numbers above were taken before it did, and are left as
they were rather than quietly rewritten.

Two things about the handover are not obvious. `bun.lock` changes when a version
does, not when somebody edits the code behind a `workspace:` or `file:` link — so
inside this repository, and in any application developed alongside a package it
links to, the bundle stays "fresh" while the code it was built from moves.
`ELVEL_BUNDLE=0` runs the source without deleting anything. And a bundle that
cannot boot takes the ordinary commands down with it, silently, which is why a
failed handover now says on stderr which file actually ran.

**Routing is core; `HttpServiceProvider` is everything around a request.** An
application that leaves it out still serves pages — the root Elysia instance and
`controller()` live in `@elvel/core` — and loses sessions, cookies, CSRF, the
rate limiters and the middleware registry. Found while measuring which providers
a landing page cannot boot without, where dropping it changed nothing that the
two probed routes touched.

What it does not do is fail quietly. A route declared with `middleware('auth')`
in such an application answers 500, not 200 — so the guard is never bypassed. But
it fails per request rather than at boot, and on the route that was meant to be
guarded, so `middlewares()` now says which provider is missing instead of
`Target [middleware] is not bound in the container`.

**`"sideEffects": false` and `bun build` do not agree about barrel files.** The
field is on every package, and `tests/side-effects.test.ts` keeps it true,
because without it importing one helper from `@elvel/http` pulled 498 modules
instead of five. What it also does, in Bun 1.3.14, is break `bun build` of the
package itself: an entry that only re-exports comes out as 0.55 KB of export list
with no implementation behind it, and throws `Exported binding ... needs to refer
to a top-level declared variable` on import. Application bundles are unaffected —
they import names, and reachable modules survive — so this only bites anyone
building the packages themselves, which is why it is written down rather than
worked around.

**`bun --hot` will not reload a program whose entry point never finishes.** This
entry used to blame Elysia's route table, and that was wrong. The symptom was
real — an edited view, controller or route kept answering with the old body
indefinitely, no error, no reload line — but the cause was one line in `serve`:
`return new Promise(() => {})`, a promise nobody resolves, awaited all the way up
to `process.exit(await kernel.run())`. Bun re-evaluates a module graph; it will
not re-evaluate one that is still evaluating, and the entry's top-level `await`
had not settled since boot.

Measured, in a five-line reproduction outside the framework: the same server
under `--hot` reloads in place when the entry returns, and never reloads when the
entry ends in a pending top-level `await`. Nothing about Elysia, nothing about
Windows, nothing about dynamic imports or a dot-directory — all four were tried
and cleared first.

The fix is `Command.holdsProcess`: `serve` returns 0 as soon as it is listening,
`Bun.serve` holds the event loop by itself, and the entry point sets
`process.exitCode` instead of exiting. A change now reaches the next request in
**72 ms**, and `bun run dev` keeps `--hot` — `--watch`, the previous answer,
restarts the process and took 2676 ms.

Two things had to move with it. The port guard treats a port *this* process
already bound as a reload rather than a conflict, because otherwise the first
edit ended `dev` with "port 3000 is already in use" naming the developer's own
server — Bun documents the second `Bun.serve` on that port as a handler swap, not
a second socket. And `holdsProcess` is only honoured when the command returned 0,
so a `serve` that could not bind still exits 1 instead of hanging the terminal on
the one failure worth reporting.


## Building the packages does not pay, and here are the numbers

The last row of the fourth `GAPS.md` was to stop shipping TypeScript source.
Packages point `main` at `./src/index.ts`, so an application installing
`@elvel/mail` gets sixteen modules to transpile rather than one file to parse, and
Bun re-transpiles every module in every process with nothing cached between runs
— 3761 ms of the auth kit's 4005 ms boot. Collapsing twenty-six packages to
twenty-six files should have removed a third of that.

An early experiment said it removed nearly half: pointing `main` at built files
inside the workspace took the auth kit from 4121 ms to 2293 ms and a landing page
from 2047 ms to 1650 ms. That number does not survive being checked. Measured
properly — real consumer installs outside any workspace, identical package sets,
three runs each, importing eight packages:

    source, 26 packages from npm      231, 234, 249 ms
    built, dependencies external      319, 324, 334 ms
    built, dependencies inlined       327, 333, 334 ms

Building is **35 to 40 per cent slower**, and inlining the third-party
dependencies — which is what the early experiment did, at 7.68 MB of output
against 0.89 MB — changes nothing. Neither install had duplicate packages: both
trees held thirty-nine at the top level.

Why a single file loses to many is not explained, and that is the honest state of
it. What is settled is that the reason for building was a measurement that did not
hold, so `scripts/release.ts` publishes source and `--built` is a flag nobody
needs to pass.

**The build itself works, and is kept.** `scripts/build-packages.ts` produces
correct output, and three things had to be solved to get there, each worth knowing
before anybody tries again:

- `"sideEffects": false` makes `bun build` emit a broken bundle from a re-export
  entry — an export list with nothing behind it, which throws `Exported binding …
  needs to refer to a top-level declared variable` on import. The field is removed
  for the length of the build. It cannot go permanently: it is what lets an
  application's bundler drop what it does not import.
- Declarations come out naming `.ts` files, because the source imports carry
  extensions, so a consumer resolving `./config.ts` looks for `config.ts.d.ts`.
  The specifiers are rewritten after emit rather than dropping extensions from
  twenty-six packages of source.
- `noEmit` is set repository-wide, so the emit needs `--noEmit false` alongside
  `--emitDeclarationOnly`, or `tsc` writes nothing and reports success.

A types-only package is the one case where a near-empty bundle is correct:
`@elvel/contracts` builds to Bun's own header comment and nothing else. The guard
tells that apart from the broken case by content rather than by size.


## Publishing, and what it took to get right

**A scope you no longer own answers 404, not 403.** The framework was `@elyvel`
until a deletion request went to npm; npm then took the names —
`npm owner ls @elyvel/core` answers `npm-support` — and the organisation went with
them. Every `PUT` after that returned `404 Scope not found`, which reads like a
missing package and is really a missing permission. Three differently-configured
tokens were tried before anybody checked ownership, which should have been the
first thing. It is now `@elvel`, an organisation this account owns.

**`private: true` is why six packages were never published.** Eight package
manifests carried it. `npm publish` answers `EPRIVATE` and stops; nothing else in
a monorepo ever asks, so the packages simply never appeared while fifteen others
depended on them. The root manifest keeps the flag; `tests/publishable.test.ts`
now refuses it anywhere under `packages/`.

**A granular token's "All packages" does not mean all packages.** Measured: with
read-and-write on all packages, `create-elvel` published and every `@elyvel/*`
returned 404. "All packages" covers what the account owns, not what an
organisation owns — for an organisation scope the token needs that scope selected
explicitly, and the scope only appears in the list while the organisation exists.

**Checking a name for availability poisons it for five minutes.** `curl
https://registry.npmjs.org/@elvel%2fcore` before publishing returns 404, and that
404 is what the CDN then serves — so the first `bun add` after a successful
publish fails, per package, on a URL somebody had already asked about. The
packages were live and public throughout: `npm access get status` said `public`
and the search index had all twenty-seven. Waiting is the fix; there is nothing
to repair.

**What the release script checks, and why each one is there.** Every tarball is
opened before anything is uploaded: `LICENSE` and a generated `README.md` are
present (neither is committed — twenty-six copies of each is noise), `test/` and
`node_modules/` are not, the version inside matches, and no dependency still says
`workspace:*`. That last one is only true because `bun pm pack` rewrites the
protocol, and only when packing from inside the package directory — from a staging
copy it would publish a range no installer can read.


## Releasing from CI, and the deadline behind it

`.github/workflows/release.yml` publishes all twenty-seven packages from a tag,
with no token stored anywhere. It calls `verify.yml` rather than repeating it, so
a release runs the same checks a push runs on all three platforms before anything
is uploaded — which is exactly what `1.0.0-alpha.1` skipped, and it needed a
second release the same day.

**Authentication is OIDC, not a token.** npm's requirement is one permission —
`id-token: write` — and with it npm generates provenance attestations by default,
with no `--provenance` flag. Nothing here has to be rotated, and there is no
secret to leak into a log.

The cost is configuration: a trusted publisher has to be set up **once per
package** on npmjs.com, naming this repository and this workflow's filename.
Twenty-seven packages means twenty-seven of those. The alternative has a deadline
rather than a cost — npm restricted bypass-2FA tokens to publishing only in
August 2026, and takes that away around January 2027.

**There is no provenance, and it is not for want of trying.** npm's provenance
attaches a verifiable link from a published version to the commit and workflow
that built it, and npm's documentation says it is automatic under trusted
publishing, with no `--provenance` flag needed. It was not happening: the
attestations endpoint answered `Not found` where a package with provenance returns
two, and the publish log never mentioned the word.

Three publishes settled it. From a tarball, no attestation. From the package
directory — the first guess, since npm generates provenance from a build context —
no attestation either. With `--provenance` asked for outright, npm signed the
statement, logged it to Sigstore's transparency log, and the registry refused the
upload:

    422 Error verifying sigstore provenance bundle: Unsupported GitHub Actions
    source repository visibility: "private". Only public source repositories are
    supported when publishing with provenance.

The repository is private. That is the whole cause, it appears in none of the four
documented prerequisites, and without the flag npm skips provenance in silence
rather than saying so. So the flag stays out: with a private repository it would
fail every release instead of improving one. Making the repository public is the
only way to have provenance, and that is a separate decision.

**Two things the workflow guards that a laptop did not.** The tag has to match the
version every manifest carries, because a release labelled one thing and
containing another is not something a tarball check can find. And
`cancel-in-progress` is off: twenty-three packages published and four not is a
state nothing can install, so a release is never interrupted by a later push.

Publishing still runs through npm even though everything else here is Bun:
trusted publishing is an npm CLI feature, needing 11.5.1 or later on Node 22.14
or later. The version check is three numbers compared in Node, rather than `npx
semver`, which would download a package in the middle of a release to answer it.


## What static analysis found, and what it got wrong

The repository went public, and with it came the security machinery GitHub gives
public repositories for nothing: secret scanning with push protection, Dependabot
alerts, private vulnerability reporting, and CodeQL. None of it had been on. The
first CodeQL run raised eighteen alerts. Nine were real enough to fix, nine were
not, and the split is worth writing down because the same queries will fire again.

**`Str.random` was biased, and it mints session identifiers.** The alphabet is 62
characters and a byte holds 256 values; `byte % 62` folds 248–255 back onto
`a`–`h`, so those eight letters turned up five times in 256 where the other
fifty-four turned up four. About 0.02 bits of entropy per character, which sounds
academic until you notice `Str.random(40)` is what `@elvel/http` calls for both
the session id and the CSRF token. It now rejects the bytes that would wrap and
redraws — roughly 3% of them — and a test feeds it a fixed byte sequence to prove
the rejection happens rather than sampling the output and hoping.

**`Arr.set` would write to `Object.prototype`.** `Arr.set(target, '__proto__.isAdmin',
true)` does not create a property called `__proto__`; it walks into the prototype
and writes there, after which every object in the process answers `isAdmin`.
Laravel's `data_set` has the same API and no such hazard, because PHP arrays have
no prototype — a place where copying the interface faithfully copies a hole that
was not in the original. Inside the framework the keys come from validation rules
rather than from request data, so nothing shipped was exploitable; `@elvel/support`
is a published package and somebody will pass it a key from a form.

Getting CodeQL to *agree* took three attempts, and the failures are instructive:
a guard in a helper function was not recognised, and neither was a guard in a loop
of its own preceding the loop that writes. What worked was `current[refusePrototypeWalk(key, segment)] = value`
— the check on the very expression that indexes the assignment. That is better
code regardless of the analyser: a new write cannot be added without going
through it.

**An unbounded DNS lookup inside request validation.** Not a CodeQL finding at
all — the macOS runner found it by taking longer than five seconds to report that
a reserved `.invalid` name does not exist, which failed the `active_url` test.
The rule called `dns.lookup` with no timeout, so a resolver that stops answering
holds the request open for as long as it likes. Three seconds now, and running out
of time fails closed like every other unanswered lookup. A flaky test was telling
the truth.

Three smaller ones: `/\s+$/` in the mail dedenter is quadratic on trailing
whitespace where `trimEnd()` is not; the console signature parser's `\{\s*(.*?)\s*\}`
backtracks where `\{([^{}]*)\}` cannot; and the release script escaped one slash
by hand where `encodeURIComponent` was the honest answer.

The nine dismissed alerts came in four flavours, all of them the analyser being
right about the shape and wrong about the context. `Math.random` in the read-replica
picker is load balancing, not key generation — it was flagged because the host it
returns carries a password field, and that password comes from configuration.
`worker-entry.ts` is a dedicated Bun Worker, not a browser window: `onmessage`
can only hear from the parent that spawned it, so there is no origin to check.
Two ReDoS reports point at strings the framework generated itself moments earlier.
And the two "incomplete hostname regexp" hits are test fixtures handed to a matcher
that escapes every metacharacter before compiling. Each is dismissed with that
reason recorded on the alert, so the next person does not re-derive it.

### A second round, and the same split

Five more arrived with the router work and the Vite harvesting, and the ratio held:
three worth fixing, two worth dismissing.

**The domain matcher escaped one character and hoped.** `Route.domain()` built its
regex with `pattern.replace(/[.]/g, '\\.')`, so any other metacharacter reached
`new RegExp` intact — `Route.domain('a.b(c).example.com')` compiled `(c)` as a
capture group and matched `a.bc.example.com`, a host nobody wrote. Escaping is now
total, which only works because the placeholders are split out first: with the
braces already gone, escaping `{` and `}` costs nothing.

**The route parameter pattern was ambiguous with itself.** `\{\s*(\w+)\s*(?::\s*(\w+)\s*)?(\?)?\s*\}`
has two `\s*` runs that can each claim the same spaces, so `{{0` followed by a long
run of them makes the engine try every split. Measured on the pattern directly: 2ms
at 2,000 spaces, 5ms at 4,000, 18ms at 8,000 — quadratic. Laravel's own pattern
allows no whitespace at all (`RouteUri.php`: `/\{([\w\:]+?)\??\}/`), so matching it
removed the ambiguity rather than working around it.

**The tag harvester did not match `</script >`.** HTML allows whitespace before the
closing bracket and Vite never writes it, so nothing was broken. That is the reason
to fix it anyway: a harvester that silently stops matching when its input gains a
space fails as a missing stylesheet three releases later, with nothing pointing back
at the regex.

The first fix was `<\/script\s*>`, and CodeQL raised the same query again on the
next run — an end tag may carry *anything* before its bracket and still close the
element, so `</script foo>` counts too. `<\/script\b[^>]*>` is the whole answer,
and the `\b` earns its place: without it `</scriptfoo>` would match, and that
closes nothing. Worth remembering that a partial fix to one of these buys a fresh
alert rather than silence.

The two dismissed are the same flavour as before. The manifest rewrite's
check-then-read already sits inside a `try` whose `catch` does nothing, so a file
that changes underneath it is skipped rather than mis-written. And stripping Vite's
`@vite/client` tag from Vite's own output is deduplication, not sanitisation —
nothing hostile reaches it, and a `<script` that survived would be a second copy of
a script the view already rendered.

**Dependabot cannot cover the dependencies.** It supports Bun for version updates
and explicitly not for security updates, so nothing would ever open a pull request
to say a package became vulnerable. `bun audit --audit-level=high` runs as its own
job in `verify.yml` instead.

Since Bun 1.4 it cannot do version updates either, and it fails silently as far as
the repository is concerned. `bun.lock` is now `lockfileVersion: 2`, and the
updater answers `Unsupported bun.lock 'lockfileVersion' 2 in /bun.lock. The bun
version Dependabot runs supports up to 1.` — so the job goes red in the Dependabot
tab, where nobody looks, rather than in `verify.yml`. An open pull request from
before the bump cannot even be rebased: it was raised against a lockfile the
updater can no longer parse. The GitHub Actions ecosystem is unaffected, which is
why action bumps still arrive and package bumps do not.

So JavaScript dependency bumps are a manual job until that support lands. And they
are two edits, not one: `packages/create-elvel/template/_package.json` pins the
same versions for scaffolded applications, and `template.test.ts` fails when the
two disagree — deliberately, because a scaffold that installs a version older than
the one this repository tested is a scaffold nobody verified. The gate is high-and-above on purpose: `release.yml`
waits on `verify.yml`, and a low advisory in some dev dependency blocking a release
is bad when a release is often how a fix ships.

**Every action is pinned to a commit.** `release.yml` runs with `id-token: write`,
which is permission to publish twenty-seven packages to npm as us. A tag is a label
somebody else can move; a SHA is not. Dependabot bumps them and keeps the version
comments beside them honest.

## The brand red is a shape colour, not a text colour

`art/logo.svg` and `art/mark.svg` are the branding, and `#FF2D20` is the red in
them. It is used exactly as given wherever it is a shape — the favicon, the nav
logo, a filled button — and **nowhere as small text**, because it does not
survive a light background.

Measured, not judged by eye:

| pair | ratio |
| --- | --- |
| `#FF2D20` on the light paper `#fbf9f5` | 3.54:1 |
| `#FF2D20` on the dark paper `#121110` | 5.07:1 |
| `#c9241a` on light — the text tint | 5.32:1 |
| `#ff5c50` on dark — the text tint | 6.20:1 |

WCAG asks 3:1 of a graphic and 4.5:1 of normal text, so the raw red passes as a
logo and fails as a wordmark. The scaffolded welcome page's `--accent` is
therefore `#c9241a` on light and `#ff5c50` on dark, and the documentation site's
`--vp-c-brand-1` matches. Laravel does the same thing: its logo is this red and
its body copy is not.

`mark.svg` is drawn in `currentColor` so one file serves both themes — but
VitePress renders a nav logo as an `<img>`, and an image cannot inherit
`currentColor`. The mark came out black in both themes, which is how that was
found; the nav uses the full `logo.svg`, which carries its own colours.

## A stub that disagreed with the dispatcher hid every model event

`Model.observe()` did nothing, silently, in every alpha up to `alpha.9`. The
lifecycle events fired, the listeners were registered, and they never met.

`ModelEvent` carried `static eventName = 'model'`, and the dispatcher names a
class-based event from its **constructor's statics** — that is what makes
`dispatch(new UserRegistered(user))` work without naming a string. So every
lifecycle event was dispatched as `model`, while `observe()` subscribed to
`article.created`, `article.saving` and the rest. Nothing matched, and nothing
complained: a dispatch with no listeners is the ordinary case.

The reason it survived a test suite is the part worth keeping. There *was* a test
for `observe()`, and it passed. `@elvel/database` does not depend on
`@elvel/events`, so the test stubbed the dispatcher — and the stub dispatched by
reading the event object's own `name` field, which is the intention rather than
the behaviour. It agreed with what the code meant and disagreed with what the
dispatcher does, which is the one thing a fake must never do.

Two changes, because one would have left the hole open:

- `fireEvent` dispatches the **string** name with the event as payload, and
  `ModelEvent` no longer carries a shared `eventName`. A wildcard covers what the
  shared name was reaching for: `listen('article.*')`, or `listen('*.created')`
  across every model.
- The stub now keys on the dispatched name, and `playground/test` runs the same
  assertions against the **real** dispatcher, where both packages are registered.

That second half is the general lesson, and it is the reason `playground/test`
exists at all: the framework's own suites build a small application per package
and must fake what they do not depend on, so an agreement between two packages can
only be checked where both are really present.

## A log stack discarded every member's level

`config/logging.ts` gives each channel a `level`, and the default channel is a
`stack`. Reached through that stack, every member's level was ignored and only the
stack's own applied — so a `json` channel set to `warning` still wrote the `info`
lines it was handed. Since `stack` is the default, that was the ordinary path: the
levels in a scaffolded application's configuration did nothing wherever anybody
had actually set one.

The cause is a boundary. **A level is enforced by the `Logger`, not by the driver
beneath it**, and `LogManager.stack()` composed bare *drivers* — so the thresholds,
which live one layer up, were never part of what it built. Each member now carries
its own level and `StackDriver` checks it before writing.

Found by writing the documentation for it: the page claimed per-channel levels
work, and running the example showed they did not.

## `auth:schema` wrote a migration MySQL refuses

Every application on MySQL, not an edge case. `session.token` is `unique` and not
`sortable`, so the generator emitted `table.text('token').unique()` — and MySQL
answers:

```
BLOB/TEXT column 'token' used in key specification without a key length
```

The whole migration therefore failed on the second table. `verification.identifier`
was the same shape with `.index()`.

The generator chose `varchar` only when better-auth called a field `sortable`, and
the comment beside that choice said why: sortable is the hint that a column is
*compared* rather than merely stored. Being part of a key is the same statement
made a different way, and it was not being read that way. A keyed string is now
`varchar` whether or not it is sortable.

**How it hid for so long.** The adapter's dialect suite built its tables by hand
with `blueprint.text('token')` and no unique constraint, so the generated
migration had never been executed against MySQL at all — only rendered and
string-matched. `BEHAVIOURS` even recorded the gap: the adapter was covered on
three dialects for the four core tables, and plugin schemas were not covered.
Adding the plugin test meant running a real generated migration on a real MySQL
for the first time, and it failed on a core table before it ever reached the
plugin's.

That is the general shape of it, twice over now: a suite that constructs the
schema it wants to test proves the query layer and nothing about the generator.
The test that found this writes the generated file to disk, imports it, runs
`up()` and then `down()`.

## `auth:schema --diff` pointed a foreign key at the wrong table

The `--diff` half had no test at all, and it is the path the documentation tells
people to use: adding a plugin to a *running* application cannot re-create the
`user` table, so the diff writes `schema.table(...)` for the column and renders
the plugin's own table in full.

Rendering that subset is where it broke. `migrationFor` resolves a reference by
looking the schema key up in the tables it was handed — and the diff hands it only
the tables that do not exist yet. So `twoFactor.userId → user` found nothing in the
subset, fell back to the raw key, and emitted `.on('user')` in an application whose
table is named something else:

```
PostgresError: relation "user" does not exist
```

`migrationFor` now takes the full set separately for resolving references, and
renders only the subset. Found by writing a test for `--diff` that runs the
migration it generates — on sqlite the plugin's table happened to be called
`twoFactor` and `user` happened to exist, so only a renamed table exposed it.

Two things this makes plain, both worth keeping:

- **An untested code path is worth finding before a user does.** `diffMigrationFor`
  had zero test coverage while being the documented way to add a plugin.
- **A test that renames things finds what a test using default names cannot.** The
  prefixed table names exist so runs do not collide on a shared Postgres, and they
  are what turned a silent fallback into a failure.

## `{--model=*}` was read as a default of `"*"`

Laravel's spelling for a repeatable option puts the star after the equals —
`mail:send {--id=*}`, invoked as `--id=1 --id=2`. The signature parser handled
`{--tag*}`, the star *before* the equals, and read the canonical form as an
option whose default value is the string `"*"`.

One command used it, and that command was broken outright. `model:prune` filtered
its models against `only = ['*']`, matched none, and reported

```
No model defines prunable()
```

against an application whose model defined one. The command was right; its own
signature was being misread. Both spellings work now.

Writing the test that found it found a second bug in the same command.
`--pretend` returned after the first batch, so it reported the **chunk size**
rather than the total: `--chunk=2` against four expired rows said "2 row(s) would
be pruned", and running it for real deleted four. It counts instead of walking
now — under-reporting on the flag whose only purpose is deciding whether to run the
real thing is the wrong direction to be wrong in.

`model:prune` reads `prunable()` off models **on disk**, so an application is the
only place it can be exercised at all — which is why it had no test while being
able to delete rows, and why the one it has now lives in `playground/test` with a
`prunable()` on `Comment`.

## What a dialect genuinely cannot index

Not a framework bug — a map, so the next person does not have to find it the hard
way. Every blueprint column type was created against all three servers, with no
key, with `.index()`, and with `.unique()`:

| Dialect | Refuses |
| --- | --- |
| sqlite | nothing |
| postgres | `json` with an index — *"data type json has no default operator class for access method btree"*. `jsonb` is fine. |
| mysql | `text`, `mediumText`, `longText`, `binary` — *"BLOB/TEXT column used in key specification without a key length"*. `json`/`jsonb` cannot be indexed at all: *"supports indexing only via generated columns on a specified JSON path"*. |

Laravel has the same limits, because they are the databases'. What this framework
adds is the reason the auth generator now picks `varchar` for any keyed string: a
generator choosing `text` for something it also indexes produces a migration that
cannot run, and unlike a hand-written blueprint there is nobody to notice.

## Every prompt hung where no terminal was attached

`migrate` in production asks for confirmation. Run from a CI job or a cron entry
there is no TTY, and the prompt rendered its question and **waited for ever** —
measured at ten minutes before the process was killed by hand:

```
⚠ Application is in production.
◆  Do you really wish to run this command?
│  ○ Yes / ● No
```

A deploy that holds its migration lock and never fails is worse than one that
fails. Nothing reports it, the pipeline sits there, and nobody is told that
`--force` is the answer.

Prompts now check `process.stdin.isTTY` and take their default, saying so:

```
Do you really wish to run this command? — no terminal attached, assuming false.
```

The default is also the safe direction, which is why this is a fix rather than a
trade: `confirmInProduction` defaults to `false`, so a non-interactive production
run now **refuses**. `--force` still goes through.

`secret()` is the exception and throws instead. A blank password is not an answer,
and a command that carried on with one would be worse than one that stopped — an
option or an environment variable is how a pipeline supplies a secret.

Found while auditing the destructive commands, which is also where the guards
themselves were checked: `db:wipe`, `migrate:fresh`, `migrate:reset`,
`migrate:refresh`, `db:seed` and `migrate` all go through `confirmInProduction`,
and `storage:unlink` refuses a real directory rather than deleting the uploads
somebody put where the symlink used to be — both verified by running them.

## A kit can be built on another kit

`--kit=jsx` is the auth kit with Tailwind and a component set, and it is the first
kit that does not stand alone:

```ts
jsx: { layers: ['auth', 'jsx'] }
```

The scaffolder copies each layer in order over the template, so a file the later
one ships replaces the one below and everything it does not mention it inherits.
`jsx` therefore carries twenty-three files — `resources/` and `vite.config.ts` —
while controllers, models, factories, the auth config and the feature tests all
come from `auth`.

The alternative was copying thirty-one files, and the two would have drifted the
first time either changed. That is not hypothetical: the field name in the
password form is `current`, not `current_password`, because the controller reads
`body.current` — a copy that guessed would fail in a way no type checks.

**A kit can now add a devDependency**, through a `manifest.json` beside its files
whose `devDependencies` and `scripts` are merged rather than copied.
`pruneDependencies` deliberately leaves devDependencies alone — it is the
toolchain, the same for every application whatever it imports — so a kit needing
a *build-time* dependency had nowhere to put one. Tailwind is exactly that. A kit
shipping a whole `package.json` would have duplicated the template's manifest,
which is the same drift in a different place.

Runtime dependencies still come from what the code imports, which is a better
answer than a list somebody has to remember to update.

### What building it found

**An error was being shown twice.** Every controller in the auth kit routes a
failure to a *field* — `withErrors({ email: … })` — and the new `Input` reads that
bag itself, so a page that also rendered an alert for the same string said it
twice: once at the top and once under the field it belongs to. Seen by signing in
with a wrong password in a real browser, not by reading the code. The field keeps
it, since it also highlights the input; the two pages whose errors belong to no
field keep their alert.

**Biome rejects Tailwind's CSS by default.** `@theme` and the rest need
`css.parser.tailwindDirectives`, or `bun run lint` goes red on a stylesheet that
is correct.

### `spa.areas` was built and then removed

It declared a prefix, a bundle and a guard per region of an application — the shape
Laravel writes as `Route::view('{path}', 'main')->middleware('auth')` beside
`Route::view('/auth/{path}', 'auth')`. Prefixed areas became real routes; the root
area was applied by the exception handler, which ran its middleware itself, because
a `GET /*` route lost to the static file plugin in development.

That last clause was a framework bug, found later and fixed: `@elysiajs/static`
with `alwaysStatic: false` claims `/*` and answers its own misses, so routing
depended on `APP_ENV` — `/deep/link` served the page in production and 404 in
development, from one source. Laravel never has this because static files are not
routes there: nginx is `try_files $uri $uri/ /index.php`, Valet's `isStaticFile()`
is `file_exists(...) ? path : false`. `alwaysStatic: true` is that shape — a route
per file that exists, and a miss falls through. A bare `.get('/*')` now works in
both environments, so the root area's exception handler was never the only way; it
is still the way that keeps the four guards.

It worked, was tested, and is gone at the maintainer's decision. Worth recording is
what it was the only answer to, so that nobody rediscovers the gap and calls it a
bug: **an address the client router owns and the server does not has no server-side
guard.** Measured as a guest on a scaffolded application: `/dashboard` 302 and
`/settings/profile` 302, because those are real routes with `middleware('auth')` —
and `/dashboard/reports` **200**, because nothing on the server claims it.

What that costs is the shell, not data: the client boots, asks `/api/session`, takes
the 401 and leaves for `/sign-in`, and every endpoint behind it carries its own
guard. An application that needs more gives the address a route.

The two things areas also did, and how they are done now: one bundle per region is
`document({ entry })` at the call site, which is what `AuthPageController` uses; and
the default for a call that names none is `spa.entry`.

### A client-only page still needs a route, or a guest can reach it

`/settings/appearance` posts nothing and reads nothing — a theme is the browser's
business. So it was a client route only, and the SPA fallback answered it: a
fallback has no middleware and cannot refuse anybody. A signed-out visitor got the
settings shell with nothing in it. The handler exists for its `auth` guard; the
document it returns is the same one every other page gets.

### A `@click` with two statements is not a Vue template expression

`@click="form.data.id = row.id; form.delete(…)"` across two lines is a parse error
at build time — `Unexpected token, expected ","`. Two of the settings pages needed
it, and both read better as a named function in `<script setup>` anyway.

### A second entry point breaks three things, and two of them silently

Areas make more than one Vite entry ordinary, and each of these appeared the first
time an application had two.

**A shared stylesheet vanishes.** Rollup hoists a stylesheet imported by two entries
into a chunk they share, so both entries report `css: []`. `vite()` read only
`chunk.css`, so the page rendered as unstyled HTML with nothing in the console —
found by looking at a screenshot, not at code. It walks the import graph now, as
Laravel's plugin does.

**`useForm` cannot post from a shell.** It read the CSRF token from the embedded
payload, and a shell carries none. `FormOptions.token` is a getter rather than a
value, because signing in rotates the session id and the token rotates with it.

**A guest cannot obtain a CSRF token at all** unless something unguarded hands it
over. `/api/session` was behind `auth` on the reasoning that a guest has no session
to describe — and sign-in then answered `419 CSRF token mismatch` on a fresh visit.
The guard belonged on the routes that read something, not on the endpoint that says
who is asking; `user: null` is a real answer.

### A client-side navigation runs no server middleware

Obvious once stated, and it cost a working page. `/settings/security` is behind
`password.confirm` on its document route — and reaching it by client-side
navigation never touches that route. What refused was the **API**, with a `423`,
which the client had no type for and displayed as "Request failed (423)".

Two things follow. Every guard on a page needs repeating on the endpoint that page
reads, because that is where the data is. And the client's answer to a `423` is to
load the same address as a document rather than to jump to the confirmation screen:
only the server's own redirect records where the person was going, so jumping
directly sent them to `/settings/security` after being stopped on
`/settings/passkeys`.

### A kit takes over a page by mounting last, not by editing the kit below it

The Vue kit needed `GET /sign-in` to answer with a document. That route lives in
the auth kit's controller, in one chain with the `POST` that calls better-auth,
rotates the session and copies the cookie.

The first attempt added an indirection *to the auth kit* — controllers naming a
page instead of importing one, so the Vue kit could replace the resolver. It
worked, and it was the wrong shape: a new kit had edited the two kits already
shipping. Reverted.

What replaced it needs nothing outside the Vue kit. `routes/web.ts` mounts its
`AuthPageController` **after** the auth kit's, and in Elysia the last registration
of a path wins — measured, since a single misplaced `.use()` gives the pages back
silently:

    const a = new Elysia({ name: 'a' }).get('/sign-in', () => 'A')
    const b = new Elysia({ name: 'b' }).get('/sign-in', () => 'B')
    new Elysia().use(a).use(b)   // → B
    new Elysia().use(b).use(a)   // → A

Two consequences live in that controller deliberately. **Shadowing a handler
shadows its middleware**, so `guest` and `auth` are named again — losing a guard
silently is worse than writing it twice. And **a page shadow must not shadow a
check**: `GET /reset-password` without a token still redirects, as the auth kit's
does.

What it costs: the auth layer's seven `.tsx` pages stay on disk, because its
controllers import them. `removes` cannot take them without breaking the import, so
the Vue kit overrides each with a stub that says it is not rendered and names the
`.vue` file to edit. Seven near-empty files, against four hundred lines of copied
auth logic or an edit to a kit that was working.

### An embedded payload belongs to the document, not to the page

Measured, and it cost a whole shell. After signing in, `router.push('/dashboard')`
arrived with the payload of the **sign-in** document: `user` was null, so `NavUser`
rendered nothing at all — no user menu, no way to sign out — and `page.csrf` was
the token `regenerate()` had just invalidated, so the next write would have been
refused.

So an auth transition loads a document. That is not a compromise: signing in
rotates the session id deliberately, and everything derived from it — the CSRF
token, who the payload describes — changes with it. `useForm`'s `onRedirect`
therefore defaults to `location.assign`, and a page whose data it fetches itself
can override that.

The same rule reaches the links: `<a href>` between auth screens, not
`RouterLink`, because a client-side push to `/sign-up` carries `/sign-in`'s flashed
error with it.

### A client navigation leaves the tab's title behind

The server sets `<title>` on the document it renders, which is right for the page
it rendered. A client-side navigation replaces the view and nothing else, so
signing in and landing on the dashboard left the tab reading "Sign in". A
`router.afterEach` sets it from `route.meta.title` — and the auth routes
deliberately declare none, because each is reached by a document load, so the
server's title is already correct and repeating it would be two places to change.

### Every document needs a `<head>`, and not every document has a caller

`spa.head` in config, not an argument to `document()`. The document a 404 renders
comes from the exception handler, which has no call site to hang options on — so a
favicon named at the controller reached the dashboard and no other page, and the
browser asked for `/favicon.ico` on every one of them. An option a caller can pass
is not enough when one of the callers is the framework.

### A layer can also take a file away

Layering was additive only, and a kit can be *smaller* than what it builds on.
`--kit=vue` renders its own dashboard, so the `auth` layer's `dashboard.tsx`
underneath it was shipped and never rendered — a developer edits it and nothing
changes on screen. `removes` in a layer's `manifest.json` deletes those, applied
after that layer's own copy so it never has to avoid naming its own files. Paths
that climb out of the target are refused rather than trusted, and a directory the
removal emptied goes too — the Vue kit takes all seven pages under
`resources/views/pages/auth`, and an empty directory left behind is a place
somebody looks for something that is no longer there.

### shadcn-vue cannot be compiled without classic TypeScript

Not a preference, and not fixable in config. A shadcn-vue component writes
`defineProps<SidebarProps>()` where the type is imported from `reka-ui`, and for a
**bare specifier** the SFC compiler has exactly one way to read that package:
TypeScript's own module resolution. Its own message says so — *"TypeScript is
required as a peer dep for vue in order to support resolving types from module
imports."*

TypeScript 7 is a native binary no JavaScript runtime can import, so `ts.sys`
comes back empty and the build fails once per component with typed props — 23
errors. Passing `script.fs` to `@vitejs/plugin-vue` covers *relative* imports and
gets no further; there is no filesystem-only path for a package. So the client
project pins `typescript@5` and `vue-tsc` in its own devDependencies, separate
from the application's. The same root cause is why `vue-tsc` cannot run in a
TypeScript 7 project at all.

### A `.vue` shim in `env.d.ts` that nothing read

The Vue kit shipped `declare module '*.vue'` and `bun run typecheck` had never
once passed in that project: `include` listed `src/**/*.ts`, `src/**/*.vue` and
`vite.config.ts`, and not `env.d.ts`, so the compiler never read the shim. Worth
knowing in both directions — the shim also types every component as
`DefineComponent<{}, {}, unknown>`, so with `vue-tsc` present it hides the props
it was there to describe.

### `.vue` files are copied byte-for-byte, and have to be

`SUBSTITUTABLE` covers `.json`, `.ts`, `.md`, `.example`, `.txt` and extensionless
files — not `.vue`, because `{{ name }}` is Vue's interpolation syntax as well as
the scaffolder's placeholder. So a component cannot carry the application's name;
the server sends it in the SPA payload instead, which is better anyway — renaming
the application is one edit in `.env` rather than a search through the client.

## Inside the checkout is not the same as inside a workspace

The scaffolder treated any target under the framework checkout as a workspace
member and wrote `workspace:*` for every framework package. That only resolves for
a directory one of the root manifest's `workspaces` globs matches — `packages/*`,
`playground`, `apps/*` — so a scaffold in a scratch directory like `.demo/` ended
up in a state where nothing worked:

```
error: @elvel/view@workspace:* failed to resolve
```

The root install ignored it, so it had no `node_modules` of its own, so nothing
could be added to it either.

What made it hard to see is that **the server still ran**. Module resolution walks
up and finds the root's `node_modules`, which really does hold the framework
packages, so `elvel serve` behaved perfectly. The break only surfaced at
`bun run build`, which needs a local `node_modules/.bin` for `vite`.

Checked against the globs now, and said out loud when it is not true: *"Inside the
checkout, but not one of its workspaces — so the published packages will be
required."* Which is a working application, just not a linked one.

## A session nobody touched is not written, and gets no cookie

Starting a session used to mint a CSRF token, and `onAfterHandle` used to record
`_previous.url` on every `GET`. Both mark the session changed, so both saved it —
and every first-time visitor to every page wrote a session and left with a
`Set-Cookie`, whether the page had a form on it or not.

Two costs, and the second is worse than the first. Measured on a scaffolded
application at fifty concurrent callers, the guest path ran at **323 requests a
second**; with the writes removed it runs at **2,561**, which is the same rate the
server serves a static file at — the session was the whole difference. And a
response carrying `Set-Cookie` is a response no shared cache will store, so an SPA
document deliberately built to be identical for everybody, and shipped with
`Cache-Control: public`, could never be cached by a CDN. The two headers
contradicted each other on every response.

What replaced it:

- `start()` mints nothing. `token()` reads; `ensureToken()` mints, and `csrfToken()`
  calls that — so a page rendering a form still gets a token and still saves.
- `_previous.url` is recorded only for a session that is already dirty. `back()`
  matters after a form is refused, and a page with a form has asked for a token.
- The cookie is issued only for a session that was written, or one that already
  exists.
- Flash data is checked rather than assumed: ageing happens *inside* `save()`, so a
  session holding a message and skipped would show that message twice.

The change is visible to any code that read `session.token()` expecting one to be
there. Two places in this repository did — the playground's `/session/token`
endpoint and a test — and both were right to be corrected: an endpoint whose
purpose is to hand out a token should say so.

## Tailwind decides where to look, and it decides badly

Tailwind v4 needs no `content` list because it finds class names itself. What it
finds, inside a larger repository, is far too much — and the cost is not the
stylesheet, it is the wait. Measured on fresh scaffolds of both kits, cold:

| | `dev` to first stylesheet | `build` | stylesheet |
| --- | --- | --- | --- |
| `jsx`, unpinned | 108.7 s | 40.8 s | 59.6 kB |
| `jsx`, pinned | 1.7 s | 0.9 s | 24.9 kB |
| `vue`, unpinned | 14.3 s | 8.4 s | 108.1 kB |
| `vue`, pinned | 3.1 s | 1.7 s | 66.6 kB |

Both kits now ship `@import "tailwindcss" source("…")`, pinned to the directory
their classes live in. The 478 utilities that stopped being generated for `jsx`
were each checked against its own `resources/`: none is used.

**An earlier version of this entry had it backwards**, and the wrong half is worth
recording. It said Tailwind *skips anything `.gitignore` covers*, so an application
in an ignored directory would find its own views invisible and the stylesheet
nearly empty. It does not: a demo under `.demo/` had its views found, along with
everything else in the checkout. Believing the opposite is why 108 seconds went
unexamined for weeks — the number was there to be measured the whole time, and the
explanation on file said there was nothing to find.

The other half was right: the default is fine for an application outside a
repository, and these numbers are a worst case. Pinning is still what ships, so the
stylesheet depends on the application rather than on its neighbours.

## Bundling changed which module ran first, and a boot check noticed

`bun run build:server` on the auth kit wrote a 4.77 MB bundle that would not
start:

    error: tsyringe requires a reflect polyfill.

Nothing in the framework or the application imports `tsyringe`. It arrives four
levels down — `@better-auth/passkey` → `@peculiar/x509` → `tsyringe` — and it
checks for `Reflect.getMetadata` *while its own module evaluates*. `@peculiar/x509`
needs the polyfill for real: its ASN.1 decorators read metadata.

From source this never happened, because the order Bun evaluated those modules in
put the polyfill first. `bun build` wraps each module in a lazy initialiser and
reached `tsyringe` first. Same code, same dependency tree, different order.

Two things made it worse than a build error. The bundle *built* fine and only
died when run, so nothing failed until the deploy did. And `elvel.ts` hands over
to `dist/elvel.js` whenever it is newer — so one `build:server` also took down
plain `bun run serve`, with a stack trace naming a file the developer did not
run.

`elvel.ts` now loads `reflect-metadata` before it imports the application, inside
a `try`, and the auth kit declares the dependency. The guard is what keeps every
other kit unaffected: no dependency, no polyfill, no failure. Verified both ways —
a passkey application boots from its bundle and serves the passkey pages, and an
application without the dependency boots unchanged.

Placement is not free choice, either. The same import inside `config/auth.ts` —
which is loaded at boot, and reads like the natural home for it — does not work.
It has to precede the application's own module graph, which is what "top of your
entry point" in that error message actually means.

The second half of the damage was the handover itself. `elvel.ts` runs
`dist/elvel.js` whenever it is newer, and said nothing about it, so a broken
bundle answered every command with a stack trace naming a file nobody ran. It now
prints the reason on stderr when the handover exits non-zero, and
`ELVEL_BUNDLE=0` runs the source with the bundle left in place — which also
covers the case the freshness check cannot see, a linked dependency edited
without `bun.lock` moving.

## `base` decides the URLs no template ever writes

A Vue island loaded on demand asked for `/assets/MemberTable-*.js` and got a 404.
The file was in `/build/assets/`.

`vite()` in a layout prefixes `/build/` itself when it reads the manifest, so
every entry point was always right — and nothing in the kit used a dynamic
`import()`, so nothing revealed that Vite knew nothing about the prefix. The
moment one did, the chunk URL Vite generated was wrong. Code splitting, `import()`
and assets referenced from CSS all come out of `base`.

It cannot simply be `/build/` always: in `serve`, `base` is also the path the dev
server answers under, while the hot-file tags point straight at
`http://localhost:5173/resources/...`. `laravel-vite-plugin` splits it the same
way — `command === 'build' ? assetUrl + '/build/' : ''` — which is why the config
is now a function of the command.

The failure mode is the reason this is written down: the build succeeds, the page
renders, and only the part that needed JavaScript is missing.

## Every per-request hook belongs to a handler, and an error response has none

`derive`, `onBeforeHandle`, `transform`, `onAfterHandle` — all of them run as part
of handling a route. A response the exception handler produces has no route:
nothing matched, or something threw before the pipeline got there. So everything
those hooks do is simply absent, which does not matter while an error page is a
paragraph of text and matters completely once an application renders a real page
there. A client-routed application does exactly that — the server cannot know
which paths the client router owns, so every one of them arrives as a 404 and
leaves as a document.

Measured on a built application, one cookie, two requests:

| request | answered by | `user()` | `csrfToken()` | `Set-Cookie` |
| --- | --- | --- | --- | --- |
| `GET /api/user` | a route, behind `auth` | the signed-in user | the session's | yes |
| `GET /dashboard` | the 404 handler | **null** | **`''`** | **none** |

Both halves fail, and the second is worse than it looks. The session was never
resolved, so it was never saved and its cookie never issued — a document rendered
there handed the client a token belonging to nothing, and the first write it
attempted came back 419. Nothing says so until that write.

`request.lifecycle` is the seam that closes it: `preparing` resolves what a scope
needs (async), `entering` puts the scope back (synchronous, because `enterWith`
is), and `finishing` writes what the finished response owes — the session saved,
the cookie appended. The core error handler runs all three, and the packages that
own those values register into it.

Three steps rather than one because of a constraint worth naming: a hook that
*answers* in Elysia's error pipeline pins the response, so none of this may return
anything. There is a test that a 500 is still a 500.

Preparation is a separate step for cost, not neatness. Resolving the session in
`onRequest` would have worked and would have added a store read to every request
that never needed one — every static asset among them. On this path the work
happens only where the answer is used.

### Saving a session is not a harmless extra write

The first version of the finisher saved unconditionally, and `save()` *ages* the
flash data: it drops what the last request flashed and promotes what this one did.
So it consumed messages nobody had read yet. CI caught four smoke checks where a
`419` for a missing CSRF token ate the flash a successful write had just set, and
the page meant to show it rendered empty. A browser asking for a favicon that does
not exist would have done the same.

Two questions, not one, because the answers differ:

- `isPersisted()` — did anything already save this request? A redirect built with
  flash data persists the session itself, so saving again drops what it had just
  promoted.
- `isDirty()` — is there anything to save? A refused write changed nothing.

A brand-new session is dirty by definition, because `start()` gives it a token —
so the case the finisher exists for, a document rendered for a first-time visitor,
is still written and still gets its cookie.

## A thrown redirect was logged as a 500

Every rejected form wrote `ERROR [stack] Redirecting to /subscribe`, with a stack
trace through `failedValidation`, for a browser on its way back to the form it came
from.

Two mistakes met. `statusFor` asked every branch it knew and none of them fits an
exception that *carries* a response: a `RedirectException` has no status of its own,
so it fell through to the 500 at the bottom. And `shouldReport` read "anything but
4xx", which sounds like nothing until an exception is used for control flow.

The status matters twice over, which is why this was worth fixing rather than
filtering in the logger: the error hook pins `set.status` from the same call.

## `split('/')` is not a path API

`path.split('/').pop()` as a file name is only a file name where the separator is a
forward slash. The migration generator returns a platform path, so on Windows the
split returned the whole absolute path and the smoke script asked to write
`storage/framework/smoke-migrations/E:/.../migrations/xxx.ts`. It died with `ENOENT
… mkdir`, and around 400 checks after that line had never run on Windows —
including the four that CI later failed on.

`basename`. The same rule caught `storage:link`, where every `lstat` failure was
read as "nothing there": a path that cannot be read is not a path with nothing in
it, and the difference is worth a sentence to whoever has to fix it.

## The lockfile can name a directory no checkout has

`workspaces` includes `.demo/*`, and those directories are gitignored — scratch
applications that exist on one machine. So `bun install` run with them present
writes them into `bun.lock`, along with every dependency they pull in, while CI
installs with `--frozen-lockfile` against a checkout where none of it exists.

It cost four reverts of `bun.lock` in one afternoon, every one noticed by accident:
the diff is hundreds of plausible lines. The glob cannot simply go — the demos
declare `@elvel/*` as `workspace:*`, which only resolves for a workspace member.

So there is a test now. It fails on the machine that has the demos, which is the
only machine that can create the problem, and it names the directory.

## Binding a port somebody else holds succeeds on Windows

`SO_REUSEADDR` permits a second bind to the same address there, so a second server
starts, reports `Server running on http://localhost:3000`, and `netstat` shows two
processes on the port. Requests go to whichever socket wins.

The report that found it was "`bun run serve` cannot be stopped with Ctrl+C" — and
Ctrl+C was working the whole time. The prompt came back, the next start said it had
succeeded, and the previous server kept answering. Two things were ruled out with
measurements before the real cause appeared: the child of `bun run` dies with its
parent, and no package registers a `terminating()` callback that could swallow the
signal.

One more measurement was worthless and worth recording as such: `process.kill(pid,
'SIGINT')` from another process killed the server, which proves nothing about
Ctrl+C — on Windows that call terminates the process rather than delivering a
console signal.

`listen()` now asks first, with a TCP connect against the port and a 300 ms
deadline, and refuses with the command that finds the process.

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

**MySQL from Bun on Windows hung until Bun 1.4, and does not any more.** Measured
on Windows against MySQL **9.7.1** on Bun **1.4.0**: the four dialect suites run
**151 tests in 9 seconds**, none skipped, none failed. That MySQL takes part is
not assumed either — pointed at a dead port instead, the same suites run 81
tests rather than 121, so forty of them are its own.

What it used to do, for anyone still on 1.3.x: not slow, stopped. The suite
reached the MySQL block and produced nothing further — no summary, no exit. The
same file on WSL Linux ran 121 tests in 6 seconds. It took a day to establish,
and what was ruled out was each measured rather than assumed: MySQL **8.4** and
**9.7.1** both hung, Bun **1.3.3** and **1.3.14** both hung, pool size **10** and
**1** both hung, the DDL was valid, both query paths were fast in isolation, and
sixty connect/disconnect cycles passed without degradation. Bun's tracker carries
a family of MySQL-only hangs — #26030, #26235, #26237, #26048, #29271, #22695 —
in which Postgres never appears.

**The suite no longer waits to find out.** `tests/support/dialects.ts` bounds its
probe at five seconds, so a server that neither refuses nor answers drops out
with `no answer in 5s — it did not refuse, it hung` and the rest of the run
finishes. That is the difference between a diagnosis and a frozen terminal, and
it is what makes the paragraph above measurable at all.

**`expect(promise).rejects` used to never settle on Windows when the promise came
from a networked driver. Fixed in Bun 1.4 as well.** Measured on 1.4.0 against
both servers: `await expect(connection.select('select * from no_such_table'))
.rejects.toThrow()` settles for MySQL and Postgres alike, two assertions in
**186 ms**.

What it did before: a rejection produced after a Postgres, MySQL or Redis round
trip hung for ever, and Bun reported "a beforeEach/afterEach hook timed out for
this test" — which sends you to hooks that measure 0–1 ms. Reproduced on 1.3.3
and 1.3.14, while the same file passed on macOS; SQLite was unaffected, as was a
plain `expect(Promise.reject(...)).rejects`. The socket was the difference.

The tests written around it were not changed back. Catching a rejection asserts
the same thing, cannot hang on any version, and reads no worse — so where a
comment says `.rejects` was avoided for this reason, that is now history rather
than a live constraint:

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
nothing native — checked directly on 1.3.12. So `@elvel/image` is two halves.
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

One thing that is correct today and will not always be. The other used to be a
`sessions.last_activity` that ran out in 2038; it is 64-bit now, and the tests
that hold it there are described further up.

- `node_modules/.bun` holds **two copies of elysia 1.4.29** under different peer
  hashes. Nothing misbehaves today, but dual module identity is exactly what the
  `file:`-dependency episode was about, and Elysia deduplicates plugins by name
  within one module instance. Worth collapsing if plugin registration ever gets
  strange.

### One dialect matrix, not four

`tests/support/dialects.ts` decides which servers a run can reach, creates
`elvel_test` on each, and hands back the list. Four suites share it — database,
queue, auth and sessions — and the sharing is the fix, not the tidying.

Each had its own copy, and two of them were subtly wrong in the same way: they
asked to connect *to* `elvel_test` instead of creating it. That works whenever the
one suite that does create it runs first, and `bun test` gave no such promise. In
CI it ran second, so `queue on postgres`, `queue on mysql`, `auth on postgres` and
`auth on mysql` skipped silently — the exact coverage those files exist for,
reported as a skip nobody read. Locally they passed, which is worse.

It surfaced only because a new sessions suite was written the same way and its
skip line was read: `skipping sessions on postgres: database "elvel_test" does not
exist`. Coverage that depends on file order is not coverage, and a matrix defined
once cannot drift in one copy.

The other half of that copy is why the test database exists at all: MySQL's system
schema `mysql` does not enforce InnoDB foreign keys, so a suite pointed there
silently passed rows a real application database rejects.

### What the tests do not reach

`bun test --coverage` reports roughly three quarters of functions. Known
uncovered, and why:

- terminal formatting (`output.ts`, `about.ts`, `db:show`, `db:table`) — the
  smoke test asserts the text that matters; pinning colour codes would test
  `picocolors`
- `serve.ts` — its `handle()` never resolves by design; the smoke test binds a
  real socket instead
- `create-elvel` — covered end to end by the smoke test rather than by units:
  it scaffolds, boots, and every package's commands are registered in what it
  wrote. A scaffold installed *from npm* is covered separately and later, by
  `scripts/verify-published.ts` in `release.yml` after the publish, because a
  workspace member never resolves a published version and that is the hole
  `alpha.1` shipped through
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
