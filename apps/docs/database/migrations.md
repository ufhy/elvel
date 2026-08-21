# Migrations

```bash
bun elvel make:migration create_posts_table
```

```ts
import { Migration, type MigrationContext } from '@elvel/database'

export default class extends Migration {
  async up({ schema }: MigrationContext) {
    await schema.create('posts', (table) => {
      table.id()
      table.foreignId('user_id').constrained().cascadeOnDelete()
      table.string('title')
      table.text('body')
      table.timestamps()
    })
  }

  async down({ schema }: MigrationContext) {
    await schema.dropIfExists('posts')
  }
}
```

**`down()` is required**, and that requirement is the whole reason `drizzle-kit`
was not used: a generated diff cannot be reversed by hand, and a migration you
cannot reverse is one you cannot deploy twice.

## Running them

```bash
bun elvel migrate
bun elvel migrate --pretend           # what would run
bun elvel migrate --step              # each migration in its own batch
bun elvel migrate --force             # skip the production confirmation
bun elvel migrate --isolated          # skip if another migrate holds the lock
bun elvel migrate:status
```

The tracking table matches Laravel's — `id`, `migration`, `batch` — and `migrate`
records **one batch per run**. `migrate:rollback` reverses the newest batch,
newest first.

On SQLite and Postgres each migration runs **in a transaction**, so a failure
halfway leaves no table behind. MySQL implicitly commits DDL, so wrapping there is
skipped rather than faked — a rollback that cannot work should not pretend to.

```bash
bun elvel migrate:rollback --step=2   # two batches back
bun elvel migrate:refresh             # reverse everything, then re-run
bun elvel migrate:fresh               # drop every table, then run
bun elvel migrate:reset               # reverse everything, run nothing
```

`migrate:fresh` and `db:wipe` **drop every table**. In production both want
`--force` and a moment's thought.

## Columns

Keys and stamps:

```ts
table.id()                      // bigIncrements primary key
table.increments('id')  table.bigIncrements('id')
table.uuid('id').primary()
table.timestamps()              // created_at, updated_at
table.softDeletes()             // deleted_at
table.rememberToken()
```

Numbers and text:

```ts
table.integer('views')  table.bigInteger('bytes')  table.smallInteger()  table.tinyInteger()
table.unsignedInteger('count')  table.unsignedBigInteger('parent_id')
table.decimal('price', 10, 2)  table.float()  table.double()
table.string('title', 255)  table.char('code', 2)
table.text('body')  table.mediumText()  table.longText()
```

Everything else:

```ts
table.boolean('published')
table.date('on')  table.dateTime('at')  table.time('at')  table.timestamp('at')
table.json('meta')  table.jsonb('meta')
table.binary('blob')  table.enum('status', ['draft', 'published'])
table.uuid('external_id')  table.vector('embedding', 1536)
table.morphs('taggable')  table.nullableMorphs('subject')
```

Modifiers chain: `.nullable()`, `.default(v)`, `.unsigned()`, `.comment('…')`,
`.collation('…')`, `.useCurrent()`, `.useCurrentOnUpdate()`, `.after('column')`,
`.first()`.

::: tip A timestamp column holding seconds should be 64-bit
`table.integer('last_activity')` runs out in January 2038 — and Postgres refuses
the insert above `2^31` rather than waiting for the date, so the failure arrives
as rows that cannot be written on a machine whose clock is merely wrong. The
framework's own `sessions` table uses `bigInteger` for exactly this.
:::

## Keys and indexes

```ts
table.foreignId('user_id').constrained().cascadeOnDelete()
table.foreignId('team_id').nullable().constrained('teams').nullOnDelete()

table.foreign('author_id').references('id').on('users').restrictOnDelete()

table.index('status')  table.unique(['team_id', 'slug'])  table.primary(['a', 'b'])
table.indexName('posts_status_idx')
```

`constrained()` guesses the table from the column name — `user_id` → `users` — and
takes one when the guess is wrong.

## Changing a table

```ts
await schema.table('posts', (table) => {
  table.string('subtitle').nullable()
  table.string('title', 500).change()
  table.renameColumn('body', 'content')
  table.dropColumn('legacy')
  table.dropUnique(['slug'])
  table.dropSoftDeletes()
})

await schema.rename('posts', 'articles')
await schema.dropIfExists('legacy')
```

## Asking the database what is there

```ts
await schema.hasTable('posts')
await schema.hasColumn('posts', 'title')
await schema.getColumnListing('posts')
```

```bash
bun elvel db:show          # the tables
bun elvel db:table posts   # the columns of one
bun elvel model:show Post  # a model, its table and its columns
```

## Squashing an old history

```bash
bun elvel schema:dump
bun elvel schema:dump --prune    # and delete the files it replaces
```

That is what keeps a five-year-old application from running four hundred
migrations to build a test database. `migrate` loads the dump first and then runs
whatever came after it; `--skip-schema` ignores it.

## Seeding

```bash
bun elvel make:seeder ArticleSeeder
bun elvel db:seed
bun elvel db:seed --class=ArticleSeeder
```

Factories build the models — see
[the database page](/database/getting-started#factories-and-seeders).

## Migrations a package ships

`cache:table`, `queue:table`, `queue:failed-table`, `queue:batches-table`,
`session:table`, `notifications:table` and `auth:schema` each write one into your
application rather than running hidden. They are **generated** because what the
table is depends on your configuration — and once written, the file is yours to
read and edit before it runs.
