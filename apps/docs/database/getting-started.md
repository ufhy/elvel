# Database

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
