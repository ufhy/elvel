# Models

```ts
import { Model } from '@elvel/database'

export class Article extends Model {
  static override table = 'articles'
  static override fillable = ['title', 'body', 'status']
  static override casts = { published_at: 'datetime', meta: 'json', views: 'int' }
  static override hidden = ['internal_notes']

  declare id: number
  declare title: string
}
```

`bun elvel make:model Article` writes one. `declare` rather than a real field:
attribute access goes through a Proxy, so `article.title` reads an attribute
while the class stays typed.

```ts
await Article.find(1)
await Article.findOrFail(1)          // throws ModelNotFoundError
await Article.all()
await Article.create({ title: 'Hi' })
await Article.query().where('status', 'published').get()
```

`get()` resolves to a **`Collection`**, not an array — `.all()`, `.count()`,
`.first()`. See [collections](/digging-deeper/collections).

## Casts

```ts
static override casts = {
  views: 'int',
  meta: 'json',
  published_at: 'datetime',
  editor_note: 'encrypted'        // ciphertext at rest, the value on the model
}
```

A cast round-trips: `typeof article.views` is `number` even though SQLite handed
back a string. `encrypted` and `encrypted:json` need `@elvel/encryption`; no
`where` on the plaintext will ever match, which is the price — see
[encryption](/security/encryption).

`hidden` keeps a column out of `toJSON()`, and `appends` puts a computed value
in. Measured on a model with `hidden = ['secret']`:

```
toJSON keys → ["id","title","views","meta","deleted_at","created_at","updated_at"]
```

## Soft deletes

```ts
export class Article extends Model {
  static override softDeletes = true
}
```

```ts
await article.delete()        // sets deleted_at
article.trashed()             // true
await article.restore()
await article.forceDelete()   // actually gone
```

Queries then exclude them by default, and three scopes reach past that. With
seven rows and one deleted:

```
Article.query().get()               → 6
Article.withTrashed().get()         → 7
Article.query().onlyTrashed().get() → 1
```

## Pagination

```ts
const page = await Article.query().paginate(1, 3)
```

```
{ rows: 3, total: 7, currentPage: 1, lastPage: 3 }
```

`simplePaginate` skips the `count(*)` when you only need next/previous.

### Cursor pagination

```ts
const first = await Article.query().cursorPaginate(3)
const next = await Article.query().cursorPaginate(3, first.nextCursor)

next.data.all().map((a) => a.id)   // [4, 5, 6]
```

**No `total` and no `lastPage`, on purpose** — knowing them costs a `count(*)`
over the whole set, which is the expense cursor pagination exists to avoid. What
it buys is stability: an offset page silently repeats or skips rows when something
is inserted while somebody is paging.

The cursor carries the last row's key, base64url-encoded as Laravel's is, so it
travels in a URL. `previousCursor` points *backwards* from the first row of the
page, which is what makes paging back work without counting.

Pass columns to page by something other than the key:

```ts
await Article.query().cursorPaginate(15, cursor, ['created_at', 'id'])
```

Several columns page like a phone book — surname first, given name only breaking
ties — so that compiles to `created_at > ? OR (created_at = ? AND id > ?)`. **The
key at the end should almost always be there**: without it, two rows sharing a
timestamp make a page boundary ambiguous.

## Lifecycle events

Eight of them: `saving`, `saved`, `creating`, `created`, `updating`, `updated`,
`deleting`, `deleted`.

```ts
events().listen('article.created', ({ model }) => index(model))
events().listen('article.*', (name) => audit(name))
events().listen('*.deleted', (name) => …)          // every model
```

The name is `<snake_case model>.<event>`. A wildcard is how you hear a whole
model's lifecycle, or one event across every model.

### Observers

```ts
Article.observe({
  creating: (article) => { article.slug ||= slugify(article.title) },
  created: (article) => index(article),
  deleted: (article) => unindex(article)
})
```

Sugar over those listeners, so one model's handlers live in one class instead of
six `listen()` calls. It needs an event dispatcher, and **says so** rather than
silently doing nothing:

```
Article.observe() needs an event dispatcher.
Register EventServiceProvider (or call Model.setEventDispatcher) first.
```

`bun elvel make:observer ArticleObserver` writes the class.

```ts
await article.saveQuietly()    // no events at all
```

::: tip This was broken in every alpha up to and including `alpha.9`
`ModelEvent` carried a `static eventName`, and the dispatcher names a class-based
event from its constructor's statics — so every lifecycle event went out as
`model` and `listen('article.created')` matched nothing, in silence. `observe()`
had a test, but the test stubbed the dispatcher and keyed on a different field, so
it agreed with the intention and disagreed with the real dispatcher. Writing this
page is what found it.
:::

## Relations

```ts
class Article extends Model {
  author() { return this.belongsTo(User) }
  comments() { return this.hasMany(Comment) }
  tags() { return this.morphToMany(Tag, 'taggable') }
}
```

```ts
await Article.query().with('author', 'comments').get()   // eager, no N+1
await article.comments().where('approved', true).get()
await article.load('author')
```

### Constraining an eager load

```ts
await Author.query().with({ posts: (query) => query.where('published', 1) }).get()
```

Without this the only way to load *part* of a relation is to load all of it and
filter in memory, which is the cost the eager load exists to avoid. The constraint
reaches the child query itself, so an `orderBy` inside it applies per parent.

### Filtering by a relation

```ts
Author.query().whereHas('posts')                        // has at least one
Author.query().whereHas('posts', q => q.where('published', 1))
Author.query().orWhereHas('posts')                      // …or has one
Author.query().whereDoesntHave('posts')
Author.query().whereRelation('posts', 'published', 1)   // the same, shorter
Author.query().withWhereHas('posts', q => q.where('published', 1))
```

Each has an `or` twin and a `doesntHave` form. `withWhereHas` is the one to reach
for on a page: it filters the parents **and** loads the children with the same
constraint, which is the pair that is easy to write out of step — a list of authors
who have published something, shown alongside all of their drafts.

```ts
Post.query().whereBelongsTo(author)          // the child side of a belongsTo
Author.query().whereAttachedTo(tag)          // the child side of a pivot
Author.query().withExists('posts')           // a posts_exists column
Author.query().withCount('posts')            // and the aggregates
Author.query().withAggregate('posts', 'votes', 'sum')
```

`withExists` is not `withCount(…) > 0`: counting walks every matching row to answer
a question that stops at the first one.

### Filtering a polymorphic relation

`whereHas` cannot serve a `morphTo` — the rows point at different tables and no
single `exists` spans them — so it refuses, and names what to use instead:

```ts
Comment.query().whereHasMorph('commentable', [Post, Video])
Comment.query().whereHasMorph('commentable', '*')        // every declared type

Comment.query().whereHasMorph('commentable', [Post, Video], (query, type) => {
  if (type === 'videos') query.where('seconds', '>', 60)
  else query.where('body', 'like', '%long%')
})

Comment.query().whereMorphedTo('commentable', post)      // this exact row
Comment.query().whereMorphedTo('commentable', null)      // pointing at nothing
Comment.query().whereNotMorphedTo('commentable', post)
```

The callback is handed the **type** as well as the query, and that is the point:
`seconds` exists on `videos` and not on `posts`, so a callback that could not tell
them apart could only name columns every type shares.

`whereMorphedTo` groups the models it was given **by type** before comparing keys,
because two types share an id space by accident: a post with id 1 and a video with
id 1 are different rows.

`'*'` uses the types the relation declares rather than running
`select distinct commentable_type` — one round trip fewer, and a type with no rows
yet still gets its subquery.

### Binding a route parameter

```ts
Route.get('/posts/{post:slug}', [PostController, 'show'])
  .middleware('bindings')
  .scopeBindings()
  .withTrashed()
  .missing(() => redirect('/posts').toResponse())
```

See [Routing](/basics/routing#route-model-binding) for what each of those does.

### Across a pivot

```ts
article.tags()
  .withPivot('added_by')   // read the extra column back, onto `tag.pivot`
  .withTimestamps()        // and stamp it on attach

tag.articles()             // morphedByMany: the pivot names the *related* type
```

Pivot columns are selected as `pivot_<column>` and moved onto the accessor after
hydration, so a pivot's own `created_at` cannot overwrite the model's. `using()`
hydrates them as a `Pivot` subclass of yours; `as()` renames the accessor.

`sync()` changes what has to change and reports what it changed:

```ts
const { attached, detached } = await article.tags().sync([1, 2, 3])
```

Rows already correct are left alone — which matters beyond the query count, because
a pivot carries its own `created_at`. Deleting and reinserting the lot would rewrite
"when did this article get that tag" for every tag it already had. A `sync` that
changes nothing writes nothing at all.

`syncWithoutDetaching(ids)` adds without removing, and `toggle(ids)` flips each id
and reports both halves. All three fire one touch rather than one per half, so a
related model naming the inverse in `static touches` is bumped once per change.

### One row, across many or through another table

```ts
user.latestOfMany(Post, 'created_at')
country.hasOneThrough(Post, User)
```

`latestOfMany` joins a grouped subquery rather than ordering and limiting. A limit
is right for one parent and **wrong for an eager load**, where it answers the whole
set once and ten users would share one post between them. The key is aggregated
alongside the column, so a tie on `created_at` cannot make a "one" relation return
two rows.

## Walking a large table

```ts
await Article.query().chunkById(500, handle)

for await (const article of Article.query().lazyById(1000)) {
  // one at a time, without the whole table in memory
}
```

Both page by primary key. That is what makes them safe to delete or update rows as
you go: an offset shifts under you and skips records.

`chunk()` and `lazy()` page by key too — **unless you ordered the query yourself**:

```ts
// By key: nothing was ordered, so nothing was promised about page boundaries.
await Article.query().chunk(500, handle)

// By offset: you asked for this order, so you get it — and its cost.
await Article.query().orderBy('title').chunk(500, handle)
```

Without an `order by`, a `limit`/`offset` pair promises nothing about which rows
land on which page, so ordering by the key is stricter than what was there rather
than looser. With one, the order is the point and paging has to honour it.

Two things follow from that, and they are the reason to prefer the `ById` forms
whenever the order does not matter to you:

- An **ordered** walk still skips rows if you delete as you go. `chunkById` never
  does, whatever it was ordered by, because it replaces the order with the key's.
- Offset paging makes the database find and discard every row before the page it
  wants, so reaching page N costs more the larger N is. Walking 400,000 rows took
  4.06s by offset against 0.70s by key.

## Scopes

```ts
class Article extends Model {
  static scopePublished(query) { query.where('status', 'published') }
}

await Article.query().scope('published').get()
```

A scope declared as `scopeUnread(query)` is reached through **`.scope('unread')`**,
not as a method of its own. `addGlobalScope(name, fn)` applies one to every query,
and soft deletes are implemented as exactly that.

`bun elvel make:scope PublishedScope` writes a class-shaped one.

## Other statics

| Static | Default | What it is |
| --- | --- | --- |
| `table` | snake plural of the class | |
| `primaryKey` / `incrementing` / `keyType` | `id` / `true` / `'int'` | A uuid key is `incrementing = false`, `keyType = 'string'` |
| `timestamps` | `true` | |
| `fillable` / `guarded` | `[]` / `['*']` | Mass-assignment |
| `touches` | `[]` | Relations whose parent gets a fresh `updated_at` |
| `routeKey` | the primary key | What route model binding matches on |
| `morphMap` | — | Stable strings for polymorphic types, so renaming a class does not orphan rows |
