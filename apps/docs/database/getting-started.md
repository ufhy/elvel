# Database

No ORM dependency. Bun 1.3 ships native SQL for **sqlite, postgres, mysql and
mariadb**, with pooling, transactions and savepoints, so the data layer has no
third-party driver at all. Drizzle was evaluated and dropped: since the query
builder, schema builder and migrator are ours, its remaining value was a schema
DSL that would duplicate migrations as a second source of truth — and
`drizzle-kit` is forward-only, with no rollback.

`Bun.SQL` sits behind a `Connection` interface, so a Node driver (`pg`,
`mysql2`, `node:sqlite`) would be an added file rather than a rewrite.

::: tip One connection is a pool of ten, and it times out after thirty seconds
`new SQL(...)` opens ten sockets by default — measured at eleven including the one
asking. Anything counting connections server-side has to allow for that, or it
reports its own pool as somebody else's leak.

The timeout is ours, not Bun's: Bun sets none, and a connection that never
completes then produces no error at all — the query waits, the process will not
exit, and nothing says why. `config/database.ts` passes
`connectionTimeout: Number(env('DB_CONNECT_TIMEOUT', 30))`, so
`DB_CONNECT_TIMEOUT` changes it per application.
:::

```ts
const users = await db().table('users')

await users.where('votes', '>', 10).orderByDesc('votes').limit(5).get()
await users.upsert({ email: 'ada@example.com', votes: 1 }, ['email'])
await connection.transaction(async (tx) => { /* rolled back on throw */ })
```

::: warning A sort direction from a request is refused, not interpolated
`orderBy(column, direction)` is typed `'asc' | 'desc'`, and a type says nothing at
runtime about a value that arrived as `?dir=…` — which is the one part of a query an
application routinely takes from outside. Anything else throws
`Order direction must be "asc" or "desc"`.

It has to, because the direction reaches SQL as a keyword rather than as an
identifier or a binding, so there is nothing quoting it. Measured against a live
database before the check existed, this ran:

```sql
order by "name" asc, (CASE WHEN (SELECT secret FROM users WHERE name = 'Ada')
                      LIKE 't%' THEN 0 ELSE 1 END) asc
```

The row order then answers the guess — a blind oracle needing no second statement,
so whether the driver permits one is beside the point.
Column names, table names and values were never exposed: identifiers are quoted with
any embedded quote doubled, values are always bindings, and operators are checked
against a list. `orderByRaw` is there when an expression is genuinely what you mean,
and its name is the whole difference — it says at the call site that the string is
trusted.
:::

Dialect differences are handled rather than assumed away, and the details come
from the upstream source:

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

Comparing part of a date is the other place no two dialects agree:

```ts
await users.whereDate('created_at', '2026-08-25')
await users.whereMonth('created_at', 8)      // a number, and it still matches
await users.whereYear('created_at', '>', 2025)
await users.whereTime('created_at', '>', '12:00:00')
await users.whereDay('created_at', 25)
```

`date(col)` on MySQL, `strftime('%Y-%m-%d', col)` on SQLite, `col::date` and
`extract(month from col)` on Postgres. SQLite's needs a `cast` as well, and that is
not decoration: `strftime` answers text and SQLite compares types before values, so
`'08' = 8` is false and an unpadded month would match **nothing** behind SQL that
reads correctly.

```ts
await users.where('active', 1).union(other).get()
await users.where('active', 1).unionAll((query) => query.from('archived_users')).get()
```

SQLite refuses a parenthesised select on the right of a `union` and needs
`select * from (…)`; the base form is a syntax error there. Both sides' bindings are
collected in reading order, because a placeholder is bound by its position — swapped,
the query still runs and answers the wrong rows.

Every `where` and `having` has its `or` twin: `orWhereNull`, `orWhereBetween`,
`orWhereColumn`, `orWhereRaw`, `orWhereLike`, `orHaving`, `orHavingBetween` and the
rest.

### One comparison, several columns

```ts
await users.whereAny(['name', 'email', 'company'], 'like', `%${term}%`)
await users.whereAll(['name', 'email'], 'like', '%ada%')
await users.whereNone(['name', 'email'], 'like', '%bot%')
```

The search box, which was otherwise a nested closure and five `orWhere`s at every
call site. `whereNone` negates the group as a whole — not each comparison, which
is a different question and a different set of rows.

### Comparing with columns rather than values

```ts
await bookings.whereBetweenColumns(moment, ['starts_at', 'ends_at'])
await orders.whereRowValues(['created_at', 'id'], '>', [cursor.at, cursor.id])
await users.whereNullSafeEquals('deleted_by', maybeNull)
```

`whereRowValues` is lexicographic — `(a, b) > (1, 2)` is not `a > 1 and b > 2` —
which is exactly what a keyset page over two columns needs.

`whereNullSafeEquals` is the comparison that does not vanish: `where('x', null)`
becomes `is null`, and a *bound* null matches nothing at all, so comparing
against a value that might be null is silently empty. It is `<=>` on MySQL,
`is not distinct from` on Postgres, and `is` on SQLite.

### JSON

```ts
await users.whereJsonContains('meta->roles', 'admin')
await users.whereJsonContainsKey('meta->beta')     // present, even holding null
await users.whereJsonOverlaps('meta->tags', ['sale', 'new'])
await users.whereJsonLength('meta->roles', '>', 1)
```

`whereJsonContainsKey` is not a comparison against null: a key holding `null` is
present and one that was never written is not, and nothing else can tell them
apart. Each has its `Doesnt` and `or` forms.

### Sub-selects, raw pieces, and lateral joins

```ts
await users.selectSub(lastOrder, 'last_order_at').get()
await users.fromRaw('(values (1), (2)) as t(n)').get()
await users.orderByRaw('field(status, ?, ?)', ['open', 'done']).get()
await users.rawValue<number>('count(*) filter (where paid)')

await users.joinLateral(recentOrders, 'recent').get()
await users.joinWhere('orders', 'orders.total', '>', 100).get()
```

A sub-select's bindings are kept apart from the wheres', because SQL reads the
select list first — one flat list pairs values with the wrong placeholders and
the query still runs. SQLite has no `lateral` and says so rather than emitting a
join whose subquery cannot see the row it is joined to.

### Writing from another query, and reading exactly one row

```ts
await totals.insertOrIgnoreUsing(['user_id', 'total'], orders.select('user_id', 'total'))
await users.join('orders', 'orders.user_id', '=', 'users.id').updateFrom({ spend: 42 })

await users.where('email', address).sole()          // exactly one, or an error
await users.where('email', address).soleValue('id')
```

`insertUsing` is all-or-nothing: one duplicate loses the whole batch, which for a
backfill run twice is the difference between a no-op and an error. `sole()` is
`first()` for a lookup that is supposed to be unique — a query that matched three
rows answers one of them and says nothing, which is how a column that turned out
not to be unique goes unnoticed for months.

MySQL has no `update … from` and says to join and update instead.

### Reading the statement, and hooks

```ts
users.where('name', 'Ada').toRawSql()
// select * from "users" where "name" = 'Ada'

users.dumpRawSql()  // print it and carry on
users.dd()          // print it and stop

users.beforeQuery((query) => query.where('tenant_id', tenant))
users.afterQuery((rows) => rows.filter(visible))

users.forceIndex('users_email_index')   // MySQL's; ignored elsewhere
users.timeout(5)                        // MySQL's hint; the others say where to set one
```

`toRawSql` is for reading, never for running: the values are quoted for display
and it is not an escaping routine. An index hint is advice, so dropping it
elsewhere changes nothing about the answer — a timeout is a promise, so an engine
that cannot keep it per statement says so rather than ignoring it.

### Models

The model layer has no brand name — it is `Model`, and the docs call them models.
A name like "Eloquent" earns its keep where an ecosystem has a marketing surface; a
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
that from becoming an N+1 — it uses the two-query strategy of
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
of a `morphTo` throws and names `whereHasMorph`, which does span them — see
[Models](/database/models#filtering-a-polymorphic-relation).

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
the fillable list does.

**A fixture is usually a graph, not a row.** Writing the loops by hand is what
these replace:

```ts
// An author with three books each
await new AuthorFactory().count(2).has(new BookFactory().count(3)).create()

// Fifteen comments belonging to one user, not to fifteen users
await new CommentFactory().count(15).for(new UserFactory()).create()

// Through a pivot
await new BookFactory().hasAttached(new GenreFactory().count(2), 'genres').create()
```

`for` shares **one** parent across the batch, which is almost always what the
fixture meant — fifteen comments by fifteen different people is a different test.
`recycle(model)` hands an instance you already have to every relation that wants
one, so a graph several levels deep does not create a new tenant at each level.

Values that differ per row come from a sequence:

```ts
await new UserFactory().count(4).sequence({ plan: 'free' }, { plan: 'paid' }).create()
await new UserFactory().count(4).crossJoinSequence(
  [{ plan: 'free' }, { plan: 'paid' }],
  [{ active: true }, { active: false }]
)
```

`sequence` cycles; `crossJoinSequence` is every combination, which is how a test
covers a matrix without naming each case.

And the rest:

```ts
await new UserFactory().makeOne({ name: 'Ada' })        // unsaved, one
await new UserFactory().createMany([{ name: 'A' }, { name: 'B' }])
await new UserFactory().createQuietly()                  // no model events

new UserFactory()
  .afterMaking((user) => { /* before it is saved */ })
  .afterCreating((user) => { /* after, with a key */ })
```

`Model.factory()` resolves one registered with
`Model.registerFactory(User, () => new UserFactory())` — the model does not
import its own factory, because that would put fixtures in the application
bundle.

::: tip There is no `connection()` on a factory
Upstream has one. Here a model's connection is a static on the class, so a
factory cannot change it for one call without changing it for everybody — the
honest way to seed a second connection is a model bound to it.
:::

Seeders are composed explicitly with `call()` — there is no auto-discovery,
because seed order matters and a directory listing is a poor way to express it. A
seeder pulled in by two others still runs once.

### Testing against real servers

`packages/database/test/dialects.test.ts` runs the same assertions against
SQLite, Postgres and MySQL. Every other test in the package asserts the SQL we
generate; this one proves a server accepts it, which is a different claim.

```bash
