# Models

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

## Factories and seeders

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

## Relations across a pivot

```ts
article.tags()            // morphToMany: the pivot stores this model's type
  .withPivot('added_by')  // read the extra column back, onto `tag.pivot`
  .withTimestamps()       // and stamp it on attach

tag.articles()            // morphedByMany: the pivot names the *related* type
```

Pivot columns are selected as `pivot_<column>` and moved onto the accessor after
hydration, so a pivot's own `created_at` cannot overwrite the model's. `using()`
hydrates them as a `Pivot` subclass of yours, and `as()` renames the accessor.

## One row across an intermediate table

```ts
user.latestOfMany(Post, 'created_at')     // one per parent, even eagerly loaded
country.hasOneThrough(Post, User)
```

`latestOfMany` joins a grouped subquery rather than ordering and limiting. A
limit is right for one parent and **wrong for an eager load**, where it answers
the whole set once — so ten users would share one post between them. The key is
aggregated alongside the column, so a tie on `created_at` cannot make a "one"
relation return two rows.

## Walking a large table

```ts
Article.query().chunkById(500, handle)     // by key: safe to delete while walking
Article.query().cursorPaginate(15, cursor)
await user.saveQuietly()                   // no model events
```

`chunkById` pages by primary key rather than by offset, which is what makes it
safe to delete or update rows as you go — an offset shifts under you and skips
records.
