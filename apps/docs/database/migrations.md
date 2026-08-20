# Migrations

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
