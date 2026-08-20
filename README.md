# Elvel

Laravel's structure and developer experience, built on [Elysia](https://elysiajs.com)
and Bun.

**Status: alpha, published on npm.** Twenty-seven packages at `1.0.0-alpha.6`,
each carrying a provenance attestation linking it to the commit and workflow that
built it. Every package the roadmap named is built; the API is still free to
change between alphas.

## Quick start

```bash
bun create elvel my-app
cd my-app
bun run dev
```

That is the whole of it: the scaffolder installs the packages, writes an `.env`
with its own generated secrets, and runs the migrations, so there is no
`key:generate` step and no placeholder key to rotate.

Three starter kits, chosen with `--kit` or at the prompt:

| | what it is | providers | dependencies |
|---|---|---:|---:|
| `none` | a landing page, no database | 10 | 14 |
| `auth` | sign in, sign up, a dashboard, settings | 17 | 22 |
| `api` | bearer-token auth, JSON, no views | 16 | 21 |

**An application installs only what its kit uses.** This is the one place Elvel
departs from Laravel by necessity: Laravel's components arrive inside a single
Composer package whether or not you touch them, while these are twenty-seven npm
packages, and registering all of them took a landing page from 1.0 MB to 3.7 MB.
So `bootstrap/providers.ts` lists what an application registers, and the kit
decides what goes in it.

Adding something later is three steps and the framework has all three — a
database, for instance, which `--kit=none` does not install:

```bash
bun add @elvel/database
bun elvel config:publish database
```

then a line in `bootstrap/providers.ts`. After that `make:model`, `migrate` and
the rest are registered.

The drivers that ship need nothing running — `cache=file`, `queue=sync`,
`mail=log`, `disk=local`, SQLite — so `bun run dev` works before Docker does.
Switching one to `database` is an env change plus the migration its command
writes: `elvel cache:table`, `queue:table`, `queue:failed-table`,
`notifications:table`.

Open <http://localhost:3000>.

```bash
bun run elvel                            # list commands
bun run elvel about
bun run elvel route:list
bun run elvel make:controller Post -r
bun run elvel make:view pages.about
bun run elvel make:component Alert
bun run elvel make:provider Route
bun run elvel make:command SendReports
bun run elvel migrate
bun run elvel migrate:rollback --step=2
bun run elvel migrate:status
bun run elvel make:migration create_posts_table
bun run elvel make:model Post -mfs        # model + migration + factory + seeder
bun run elvel db:seed
bun run elvel db:show
bun run elvel db:table users
bun run elvel make:event OrderShipped
bun run elvel make:listener RecordShipments --event OrderShipped
```

## Packages

| Package | Contents |
| --- | --- |
| `@elvel/contracts` | Interfaces only. Breaks dependency cycles between packages. |
| `@elvel/support` | `Str`, `Arr`, `Collection`, `Macroable`, `Conditionable`. |
| `@elvel/core` | `Application`, `ServiceProvider`, `Config`, `Env`, exception handler, `controller()`, helpers. |
| `@elvel/database` | Connections, query builder, models, schema builder and migrator on Bun.SQL. |
| `@elvel/http` | `FormRequest`, `JsonResource`, sessions, signed and encrypted cookies, CSRF, rate limiting, CORS, trusted proxies. |
| `@elvel/validation` | Two-phase validation: ~50 rules, `unique`/`exists`, error bags. |
| `@elvel/events` | Dispatcher with wildcards, halting, subscribers, `EventFake`. |
| `@elvel/log` | Channels and drivers (console, json, single, daily, stack, null). |
| `@elvel/console` | The CLI: signature parser, command base, kernel, stub generators. |
| `@elvel/view` | JSX renderer (`@kitajs/html`), `view()`/`render()` helpers, static file serving. |
| `@elvel/auth` | better-auth over our own query builder, plus Gate and policies. |
| `@elvel/cache` | Four stores (array, file, database, redis) with atomic locks, tags and a rate limiter. |
| `@elvel/queue` | Jobs, three drivers, worker with Laravel's retry policy, chains, failed jobs. |
| `@elvel/scheduler` | Cron matcher, `withoutOverlapping`, timezones, `schedule:run`/`schedule:test`. |
| `@elvel/mail` | Mailables, nodemailer transports, queued mail. |
| `@elvel/storage` | Disks (`local`, `s3` on Bun.S3Client), path guard, offline presigned URLs. |
| `@elvel/notifications` | Channels (mail, database, log), per-recipient ids, on-demand recipients. |
| `@elvel/encryption` | AES-256-GCM, HKDF-derived keys, context binding, key rotation, `key:generate`. |
| `create-elvel` | Application skeleton scaffolder. |

## Design decisions

**The container is typed, not stringly-typed.** Laravel leans on
`app('cache')` + facades; copying that verbatim would destroy Elysia's
end-to-end inference, its main advantage. Bindings are declared by augmenting
`ContainerBindings`, so `app('view')` resolves to a real type. That interface
must stay an `interface` — a type alias cannot be augmented.

**Controllers are Elysia instances, not classes of static handlers.** This is
what Elysia's own docs prescribe, and the only shape that keeps the request
context inferred inside handlers. Each controller carries a `name` so Elysia
deduplicates its routes.

**Global helpers instead of context decorators.** `view()`, `config()`, `app()`
resolve from the running application, like Laravel's helpers. Decorating the
Elysia context instead would force every route to carry those types.

**Views are typed JSX, not a template language.** `@kitajs/html` compiles JSX
straight to strings — no virtual DOM, ~2-3x faster than React/Preact/Hono JSX at
about half the memory. A view is a function, so `tsc` is the template checker and
Bun's module cache is the compile cache: no view paths, no compiled-view
directory, and a renamed prop is a compile error instead of a blank page.

Components are passed by reference, never by name:

```ts
// app/Http/Controllers/PageController.ts  — stays .ts, no JSX syntax here
import { view } from '@elvel/view'
import { Landing } from '../../../resources/views/pages/landing.tsx'

.get('/', () => view(Landing, { title: 'Welcome' }))
```

Only files containing JSX syntax need `.tsx`; a `.ts` file with a JSX literal is
a syntax error in both `tsc` and Bun. Layouts are components and the page body
arrives as `children` (typed as `Children` from `@kitajs/html`). `view()`
prepends `<!DOCTYPE html>` when the markup opens with `<html`, since JSX has no
doctype node.

**Escaping is opt-in.** Mark interpolated user input with `safe` —
`<span safe>{comment}</span>` — and it is HTML-escaped at render time. The
matching compile-time checker, `@kitajs/ts-html-plugin`, **cannot be wired into
`bun run verify` today**: its CLI reads `typescript.sys`, which TypeScript 7
removed from the default export, so it crashes under both Bun and Node. Until
that is fixed, `safe` is a runtime guarantee and a review responsibility.

**Workspace linking, never `file:` dependencies.** Bun hardlinks `file:`
dependencies into its store; an editor that writes by replacing a file detaches
the copy, and the app then runs stale code while TypeScript sees two identities
of the same module. Apps scaffolded inside this repo become workspace members.

## Events and logging

Both follow `Illuminate\Events\Dispatcher` and `Illuminate\Log\LogManager`
semantics, read from the source rather than guessed:

```ts
// A class event is its own payload, and its listener's argument is typed.
class OrderShipped {
  static readonly eventName = 'order.shipped'   // survives class renaming
  constructor(readonly orderId: number) {}
}

events().listen(OrderShipped, (event) => event.orderId)   // typed
events().listen('order.*', (name, payload) => {})         // wildcard
await dispatch(new OrderShipped(42))
```

- a listener returning `false` stops propagation; `until()` returns the first
  non-null response and skips the rest
- wildcard matches are cached per event name and invalidated when a new pattern
  is registered
- `push()`/`flush()` defer through a synthetic `<event>_pushed` event
- classes in `app/Listeners` with a `subscribe` method are discovered
  automatically; `EventFake` records dispatches for tests and `NullDispatcher`
  swallows them while keeping registration observable

A listener can run in a worker instead of the request. It is a **class** rather
than a closure, for the same reason a job is: the worker is another process, so
only a name travels.

```ts
export class NotifyWarehouse extends QueuedListener<OrderShipped> {
  static override queue = 'shipments'
  static override tries = 3
  static override afterCommit = true          // wait for the commit, or drop it

  async handle(event: OrderShipped) {
    event.label()                             // the event is rebuilt as itself
  }

  override failed(event: OrderShipped, error: unknown) {}
}

events().listen(OrderShipped, NotifyWarehouse)   // pushed, not called
```

- `app/Events` is discovered into a registry, so the worker rebuilds the event
  from its class — its methods and `instanceof` survive the trip, which handing
  over loose JSON would not
- `shouldQueue(event)` is asked in the process that dispatched, the only one that
  still has the request's state
- `afterCommit` holds the push until the outermost transaction commits and drops
  it if that transaction rolls back; without it a worker can reserve a job whose
  rows were never committed
- the dispatcher knows nothing about queues — the push is a hook installed by
  `QueueServiceProvider`, and a queued listener with no queue registered **throws**
  rather than quietly running in the request
- `elvel make:listener NotifyWarehouse --event OrderShipped --queued` writes one

```ts
log().info('User {id} signed in', { id: 7 })    // {placeholders} interpolate
log().channel('daily').warning('Disk filling')
log().shareContext({ request_id: id })          // sticks to every channel
log().extend('pino', (config) => new PinoDriver(config))
```

Channels pair a driver with a minimum level, using the same eight RFC 5424
levels and Monolog's severity numbers, so a `level` behaves as it does in
Laravel. A typo in a level or a stack that includes itself fails at boot rather
than at 3am. Logging is fire-and-forget: `log().info()` never awaits its driver,
so a file write cannot slow a request.

`config/logging.ts` also carries an opt-in access log (`LOG_REQUESTS=true`) that
attaches a request id and reports method, path, status and duration.

## Database

No ORM dependency. Bun 1.3 ships native SQL for **sqlite, postgres, mysql and
mariadb**, with pooling, transactions and savepoints, so the data layer has no
third-party driver at all. Drizzle was evaluated and dropped: since the query
builder, schema builder and migrator are ours, its remaining value was a schema
DSL that would duplicate migrations as a second source of truth — and
`drizzle-kit` is forward-only, with no rollback.

`Bun.SQL` sits behind a `Connection` interface, so a Node driver (`pg`,
`mysql2`, `node:sqlite`) would be an added file rather than a rewrite.

```ts
const users = await db().table('users')

await users.where('votes', '>', 10).orderByDesc('votes').limit(5).get()
await users.upsert({ email: 'ada@example.com', votes: 1 }, ['email'])
await connection.transaction(async (tx) => { /* rolled back on throw */ })
```

Dialect differences are handled rather than assumed away, and the details come
from Laravel's source:

- **placeholders** — PDO normalises them and Bun.SQL does not, so `parameter()`
  is per-dialect: postgres emits `$1..$n`, the others `?`
- **upsert** — `on conflict (…) do update` for postgres/sqlite, `on duplicate
  key update` for mysql, which has no conflict target
- **auto-increment** — sqlite collapses every integer width to `integer` and
  inlines `primary key autoincrement`; postgres uses `bigserial`; mysql appends
  `auto_increment primary key`
- **modifier order** — verbatim per grammar, because SQL rejects the wrong one:
  sqlite puts `increment` first, mysql puts `unsigned` first and position last
- **truncate** — sqlite deletes rows and resets `sqlite_sequence`, postgres
  restarts identity, mysql truncates

An empty `whereIn` compiles to `0 = 1` rather than invalid SQL, and where
operators are validated against a known list instead of interpolated.

### Models

The model layer has no brand name — it is `Model`, and the docs call them models.
Laravel needs "Eloquent" because its ecosystem has a marketing surface; a
descriptive name costs nothing to explain.

```ts
class User extends Model {
  static override table = 'users'
  static override fillable = ['name', 'email']
  static override casts = { active: 'boolean', meta: 'json' }

  declare id: number
  declare name: string

  posts() { return this.hasMany(Post) }
}

const user = await User.create({ name: 'Ada' })
await User.where('votes', '>', 10).orderByDesc('votes').paginate(1, 15)
```

Attribute access goes through a Proxy, so `user.name` reads an attribute while
`user.save()` stays a method; `declare` gives the columns types without
shadowing it at runtime. Casts matter more here than in PHP — SQLite has no
boolean, so `active` arrives as `0`, and `'0'` is truthy in JavaScript.

**Relations are methods, and there is no synchronous lazy loading.** Reaching the
database is asynchronous on Bun, so `user.posts` cannot return rows the way
`$user->posts` does; it is `await user.posts().get()`. `with()` is what keeps
that from becoming an N+1 — it uses the two-query strategy from Laravel's
`addEagerConstraints`/`match`: collect the parents' keys, fetch every child in
one `where in`, build a dictionary, assign. Parents with a null key are skipped
rather than matched against null. `hasMany`, `hasOne`, `belongsTo` and
`belongsToMany` are covered, including `attach`/`detach`/`sync` and nested
`with('posts.comments')`.

Saving follows `performUpdate`: only dirty columns are sent, and a clean model
issues **no query at all**. Dirty comparison tolerates driver type drift, so a
column that comes back as `5` and is reassigned `'5'` is not reported as changed.

Also present: global scopes (`addGlobalScope` / `withoutGlobalScope`),
`whereHas`/`has`/`doesntHave` as correlated `exists` subqueries so the parent
rows are never multiplied, `withCount`/`withSum`/`withMax` as select subqueries,
accessors and mutators (`getFullNameAttribute`), `appends`, `getChanges` /
`wasChanged`, `replicate`, `is`/`isNot`, `only`/`except`, `withoutTimestamps`,
`sole`, `firstWhere`, `lazy()`, morph relations (`morphTo`/`morphOne`/`morphMany`),
`hasManyThrough`, and the full pivot surface (`attach`/`detach`/`sync`/
`syncWithoutDetaching`/`toggle`/`updateExistingPivot`).

`morphTo` eager loading issues one query per distinct type, which is the floor
rather than a shortcoming: the rows point at different tables. Asking `whereHas`
of a `morphTo` throws with an explanation instead of guessing a table.

### Factories and seeders

```ts
class UserFactory extends Factory<User> {
  readonly model = User

  definition(index: number) {
    return { name: `User ${index}`, email: `user${index}@example.com` }
  }
}

await new UserFactory().count(3).state({ active: false }).create()
```

No fake-data generator is bundled. `definition()` receives a 0-based index, so
unique values are derived from it rather than from a random source that collides
with a unique index roughly one run in fifty. Factories bypass `fillable`, as
Laravel's do.

Seeders are composed explicitly with `call()` — there is no auto-discovery,
because seed order matters and a directory listing is a poor way to express it. A
seeder pulled in by two others still runs once.

### Testing against real servers

`packages/database/test/dialects.test.ts` runs the same assertions against
SQLite, Postgres and MySQL. Every other test in the package asserts the SQL we
generate; this one proves a server accepts it, which is a different claim.

```bash
# defaults to 127.0.0.1:5432 (postgres) and 127.0.0.1:3309 (mysql)
TEST_POSTGRES_URL=postgres://user:pass@host:5432/db bun test dialects
```

A dialect whose server is unreachable is skipped with a note rather than
failing, so the suite stays green without them — but then it is only proving
SQLite. It creates its own `elvel_test` database per server: MySQL's system
schema `mysql` does **not** enforce InnoDB foreign keys, so running there
silently accepted rows a real application database rejects.

Three bugs it caught that no amount of SQL-string assertion would have:

- the schema grammar's introspection queries hardcoded `?`, so `hasTable` and
  `getColumnListing` were unparseable on Postgres — placeholders leak beyond
  the query grammar
- `default true` on a boolean column compiled to `default 1`, which Postgres
  rejects as a type error
- the boolean cast wrote `1`/`0`, which Postgres also rejects; it now writes a
  real boolean, which every dialect accepts

Known and deliberate: MySQL refuses to `truncate` a table a foreign key points
at, however empty the child is. The grammar does not disable foreign key checks
behind your back, so `delete()` is the way to empty such a table.

### Migrations

```ts
export default class extends Migration {
  async up({ schema }: MigrationContext) {
    await schema.create('posts', (table) => {
      table.id()
      table.foreignId('user_id').constrained().cascadeOnDelete()
      table.string('title')
      table.timestamps()
    })
  }

  async down({ schema }: MigrationContext) {
    await schema.dropIfExists('posts')
  }
}
```

`down()` is required, which is the whole reason `drizzle-kit` was not used. The
tracking table matches Laravel's (`id`, `migration`, `batch`), `migrate` records
one batch per run (`--step` gives each migration its own), and
`migrate:rollback` reverses the newest batch newest-first. On sqlite and postgres
each migration runs in a transaction, so a failure halfway leaves no table
behind; mysql implicitly commits DDL, so wrapping there is skipped rather than
faked.

## Bootstrap order

Fixed, and it mirrors `Illuminate\Foundation\Http\Kernel`:

```
env -> config -> exceptions -> register providers -> boot providers -> routes
```

Framework providers come from `config/app.ts`; application providers are passed
to `Application.configure().withProviders()` so they register last and can
override framework bindings. Events and logging are registered first, as
Laravel's base providers are, because everything booting after them may emit
events or write logs.

## Development

Working on the framework itself rather than on an application built with it:

```bash
git clone https://github.com/ufhy/elvel
cd elvel
bun install
bun run verify   # lint -> typecheck -> test -> smoke. Run this on every change.
```

To scaffold an application *inside* the checkout, against the packages you are
editing rather than the published ones:

```bash
bun run create apps/blog
bun install                # link the new workspace member
cd apps/blog && bun run dev
```

A scaffold inside the checkout becomes a workspace member and resolves
`@elvel/*` by symlink. That is convenient and it hides things: a manifest is only
ever exercised by somebody else's install, which is how a published release once
went out declaring none of the packages its own source imported.
`tests/publishable.test.ts` checks the manifests directly for that reason.

Individually:

```bash
bun run lint
bun run typecheck
bun run test     # 2,462 tests, including those against real Postgres and MySQL
bun run smoke    # 783 checks against the real playground app
```

### playground/

`playground/` is a tracked workspace member — the same skeleton `bun run create`
produces, plus an `ExerciseController`, an `exercise.tsx` view (with an async
component and a deliberately unsafe-looking prop), and a `Ping` command that
exist purely to give the smoke test something real to assert against.

```bash
bun run playground:dev              # serve it with --watch
bun run playground route:list       # any Elvel command
bun run playground:reset --force    # regenerate from the template (destructive)
```

Because the framework packages are linked by symlink, editing `packages/*` takes
effect in the playground immediately — which is the point: `bun run smoke` boots
this app, renders its views, runs its commands, generates code into it (then
cleans up), scaffolds a throwaway project, and binds a real socket. A broken
template or stub fails there even when every unit test still passes.

`tests/fixture` is a separate, minimal application used by the automated
integration tests; the playground is for end-to-end checks and manual poking.

### Test coverage

`bun test --coverage` reports **74% of functions / 85% of lines**. Every package
has unit tests except `contracts` (interfaces only, no runtime) and
`create-elvel` (covered end to end by the smoke test).

Deliberately not unit-tested:

- `output.ts` and `about.ts` — terminal formatting; the smoke test asserts the
  text that matters, and pinning colour codes would test `picocolors`.
- `serve.ts` — its `handle()` never resolves by design; the smoke test binds a
  real socket instead.
- `command.ts` accessors — exercised through the kernel and generator tests
  rather than in isolation.
- `str.ts` inflection edge cases beyond the common forms.

## Validation

Two phases, because TypeBox has no async path and no `refine` — this is a
constraint, not a preference.

**Phase one is the Elysia `body` schema**: shape, type and format, checked
synchronously before the handler runs, and the same schema that produces the
OpenAPI document.

**Phase two is `validator()`**: everything TypeBox cannot express.

```ts
const check = validator(body, {
  name: 'required|string|min:2',
  email: ['required', 'email', Rule.unique('users', 'email').ignore(user.id)],
  password: 'required|min:8|confirmed',
  team: 'required_if:role,admin'
})

const data = await check.validate()   // throws ValidationError with the bag
```

The execution model follows `Illuminate\Validation\Validator::passes()`, and the
details are what make an error bag readable rather than noisy:

- a rule runs only if the value is present or the rule is **implicit** (the 24
  `required*`/`present*`/`accepted*` rules), so `required` can fail on a key that
  was never sent
- an implicit failure **stops the remaining rules for that attribute** — an empty
  field reports "required" alone, not also "min" and "email"
- a whitespace-only string counts as absent
- `nullable` lets an explicit null through, `sometimes` skips an absent key,
  `bail` stops at the first failure
- `exclude_if` and friends **drop the attribute** instead of failing it
- `validated()` returns only what was validated, so an unchecked field cannot
  reach a database write

`unique` and `exists` read the database through a `PresenceVerifier`, which is an
interface: `@elvel/validation` has **no dependency** on `@elvel/database`, and
the two rules explain themselves if no verifier is available. Both support the
string form (`unique:users,email,ignoreId,idColumn`) and the object form with
extra constraints (`Rule.unique('users','email').where('tenant', id)`).

`FormRequest` is deliberately *not* here: it needs the request context and
session, so it belongs to the `http` package. This one works in a command or a
seeder with no HTTP at all.

## HTTP

`FormRequest` completes the validation story, in the order
`ValidatesWhenResolvedTrait` defines: `prepareForValidation` → `authorize` →
rules → `passedValidation`.

```ts
class StoreArticleRequest extends FormRequest {
  authorize() { return true }          // false is a 403, never a 422
  prepareForValidation() { this.merge({ title: String(this.input('title')).trim() }) }
  rules() { return { title: 'required|min:3', status: 'required|in:draft,published' } }
}

const data = await validateRequest(StoreArticleRequest, { body })
```

Authorization is checked **before** the rules, so a refused request cannot reveal
which fields would have failed. `validated()` returns only validated keys;
`safe().only()/except()` slices it. `failOnUnknownFields` rejects keys no rule
mentions.

`JsonResource` makes a conditional key **absent** rather than null — a null tells
a client the value exists and is empty:

```ts
class ArticleResource extends JsonResource<Article> {
  toObject() {
    return {
      id: this.resource.id,
      notes: this.when(viewer.isEditor, () => this.resource.notes),
      comments: this.whenLoaded('comments'),        // never lazily loads
      links: this.merge({ self: `/articles/${this.resource.id}` })
    }
  }
}
```

```ts
article.tags()            // morphToMany: the pivot stores this model's type
  .withPivot('added_by')  // read the extra column back, onto `tag.pivot`
  .withTimestamps()       // and stamp it on attach

tag.articles()            // morphedByMany: the pivot names the *related* type
```

```ts
Article.query().chunkById(500, handle)    // by key: safe to delete while walking
Article.query().cursorPaginate(15, cursor)
await user.saveQuietly()                  // no model events

user.latestOfMany(Post, 'created_at')     // one per parent, even eagerly loaded
country.hasOneThrough(Post, User)         // one row across an intermediate table
```

`latestOfMany` joins a grouped subquery rather than ordering and limiting: a limit
is right for one parent and wrong for an eager load, where it answers the whole set
once. The key is aggregated with the column so a tie on `created_at` cannot make a
"one" relation return two.

Pivot columns are selected as `pivot_<column>` and moved onto the accessor after
hydration, so a pivot's `created_at` cannot overwrite the model's own. `using()`
hydrates them as a `Pivot` subclass of your own, and `as()` renames the accessor.

Sessions are driver-based (`file`, `memory`) with Laravel's flash semantics: a
flashed value survives exactly one further request, implemented with the same
`_flash.new` → `_flash.old` ageing. CSRF compares `_token` or `X-CSRF-TOKEN`
against the session token in **constant time**, exempts read methods and
configured paths, and answers 419 on a mismatch.

**Cookies are signed by default, and can be encrypted.** A signed value stays
readable by the client but cannot be altered without the key; the session cookie
carries only an id, so signing is enough for it. Setting `SESSION_ENCRYPT=true`
encrypts it instead, through `@elvel/encryption`, **bound to its own name** — the
cookie name is authenticated as the AEAD's associated data, so a value lifted into
a different cookie fails to decrypt. Reading falls back from decrypt to unsign, so
turning encryption on does not log everybody out. An encrypted `X-XSRF-TOKEN` is
still *rejected* rather than waved through.

```bash
bun elvel down --retry=60 --except=/health --with-secret   # 503, but /health still answers
bun elvel down --render=errors.maintenance                 # bake the page now, serve it later
bun elvel up
```

Maintenance mode keeps its payload in **a file**, because the reason to need it is
often that the database or Redis is what broke. `--with-secret` prints a URL that
sets a bypass cookie — a MAC over the cookie's own expiry, so the phrase never
reaches the browser and a copied cookie expires by itself. A scheduled entry is
skipped while the application is down unless it says `evenInMaintenanceMode()`.

A rejected form goes **back to itself**, with the messages and what was typed:

```ts
// In the handler: nothing about redirecting is written here.
const data = await validateRequest(SubscribeRequest, { body, request })
```

```tsx
// In the view: no props threaded through, because a component has no scope to
// share `$errors` into — `errors()` and `old()` read the request instead.
<input name="email" value={old('email')} />
{errors().has('email') && <p class="error">{errors().first('email')}</p>}
```

- a browser is redirected; a client asking for JSON — by `Accept`, by
  `X-Requested-With`, or by *sending a JSON body* — still gets the 422 and the bag
- `password`, `password_confirmation`, `current_password`, `token` and uploads are
  never flashed, at any depth
- flash data survives exactly one further request, so nothing has to clean up
- `redirect('/x')`, `redirect().back()`, `.with()`, `.withErrors()`, `.withInput()`,
  `.seeOther()`, `.permanent()`

```ts
await queue()
  .batch([new ImportRow(1), new ImportRow(2)])
  .name('nightly import')
  .onSuccess(NotifyFinished)   // a job class, not a closure
  .onFailure(AlertOncall)
  .dispatch()
```

A batch counts its jobs down in a table, so several workers agree on the progress.
The callbacks are **job classes**: a closure cannot be rebuilt in the worker that
would run it, and naming a job means the callback gets retries and a failure record
too. They are `onSuccess`/`onFailure`/`onFinished` rather than Laravel's
`then`/`catch`/`finally`, because a class with a `then` member is a thenable and
`await`ing the builder would call it with `resolve` instead of a job. The first failure cancels the rest unless `allowFailures()`, and a cancelled
batch's remaining jobs are skipped when reserved — a driver cannot reach in and
delete them.

`maxExceptions` is counted in the cache, keyed by the payload's uuid: a job with
`tries = 25` and `maxExceptions = 3` is one expected to be released often but which
should still give up when it is actually broken.

Rate limiting, CORS and trusted proxies are middleware:

```ts
controller('api')
  .use(throttle({ max: 60, decay: 60 }))        // or throttle('api'), a named one
  .get('/orders', () => …)

limiters().for('uploads', ({ ip, user }) =>      // in a provider's boot()
  user?.id ? Limit.perMinute(500).by(String(user.id)) : [Limit.perMinute(3).by(ip), Limit.perDay(50).by(ip)]
)
```

- a refusal is **429** with `Retry-After` and `X-RateLimit-Reset`, so a client
  waits the right amount instead of guessing — guessing is what turns a rate limit
  into a retry storm
- two windows over one subject get two counters, and the response reports the
  tightest remaining
- `throttle()` is scoped to the plugin it is used in: one per `routeGroup()` when
  two routes need two budgets
- CORS is driven by `config/cors.ts`; `paths` is the switch, `*` is never sent for
  a credentialed request, and a refused origin gets a normal response with no CORS
  headers rather than a 403
- `X-Forwarded-For` is believed only from a proxy named in `http.trustedProxies` —
  trusting it while directly exposed hands every caller a fresh identity per
  request

Errors are rendered by **one** handler, in core: `ValidationError` carries
`status = 422` and its bag is picked up duck-typed. A second `onError` in the http
package raced the first one and lost, which is how that was found.

## Encryption

One AEAD, chosen rather than configurable: **AES-256-GCM**, through Bun's
synchronous `node:crypto`. Encryption is therefore not an `await` in the middle of
an accessor.

```ts
encryptString('4111111111111111')          // v1.<nonce>.<ciphertext‖tag>
encrypt({ card: '4111…' }, 'card:1')       // JSON, bound to a purpose
decrypt<Card>(payload, 'card:1')           // throws unless the purpose matches
```

Three things worth stating:

**Keys are derived, never used raw.** `APP_KEY` goes through HKDF with a purpose
string, so the cookie *signer* and the *encrypter* share an origin but no key
material. `elvel key:generate` writes one and refuses to overwrite an existing
key without `--force`, printing the `APP_PREVIOUS_KEYS=` line that keeps old
payloads readable through the rotation.

**Context is authenticated, not carried.** The second argument becomes the AEAD's
associated data: it costs no bytes, appears nowhere in the payload, and makes a
value encrypted for one purpose fail to decrypt as another. That is what stops a
cookie value being pasted into a different cookie, or a job payload into a
different job.

**Every failure reads the same** — "Could not decrypt the payload." — whether the
version, length, tag, context or key was wrong. Distinguishing them is how an
oracle attack starts.

It reaches three places:

| Where | How |
| --- | --- |
| Cookies | `SESSION_ENCRYPT=true`, or `cookies().encrypt(name, value)`, bound to the cookie name. |
| Queue payloads | `static encrypted = true` on a job. The queue stores a ciphertext it cannot read; the worker decrypts it, bound to the job class. |
| Model columns | `casts = { editor_note: 'encrypted' }` (or `'encrypted:json'`). Ciphertext at rest, the value on the model — and no `where` on the plaintext will ever match, which is the price. |

## Behaviours and limits

[`BEHAVIOURS.md`](BEHAVIOURS.md) explains the decisions that are easy to misread
from the outside — why a cancelled batch never finishes, why a `..` that stays
inside a disk is allowed, why the day-of-month rule is POSIX's and not the
obvious one.

Its last section is where the framework stops: what the tests do not reach and
why, two things that are correct today and will not always be, and the one
feature that was attempted and could not be made to work (compile-time XSS
checking, blocked by a TypeScript 7 incompatibility in `@kitajs/ts-html-plugin`).

## Security

Found a hole? **Do not open an issue.** Report it privately through
[GitHub's advisory form](https://github.com/ufhy/elvel/security/advisories/new),
or by email to `suryadi.tahir@kalla.co.id`. [SECURITY.md](SECURITY.md) says what
is in scope and what to include.

Every push runs CodeQL and `bun audit`; secret scanning with push protection is
on. `BEHAVIOURS.md` records what the first CodeQL run found.

## Roadmap

The roadmap agreed at the start is complete: core, console, view, events, log,
database, validation, http, auth, cache, queue, scheduler, mail, storage,
notifications, and the encryption package the last three items were waiting on
(encrypted cookies, encrypted queue payloads, encrypted model casts).

Where each package stops — and why — is in
[`BEHAVIOURS.md`](BEHAVIOURS.md).

What is left is not features. Two things worth knowing before depending on this:

**Packages ship TypeScript source**, so your `tsc` compiles their internals. That
makes the types exact and it makes our problems yours: `@elvel/mail` imported an
untyped subpath and applications that installed it failed their own typecheck
while ours passed, because the types sat in this repository's root. Building each
package to one file would end that class of bug, and measured, it also made boot
35 to 40 per cent *slower* — so it is not done, and `BEHAVIOURS.md` has the
numbers.

**Nothing here has run in production.** The suite covers SQLite, Postgres and
MySQL, the queue drivers, and both caches, and the smoke run drives a real
application over a socket. None of that is the same as a year of somebody else's
traffic.
