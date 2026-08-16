import app from '../bootstrap/app.ts'

/**
 * The template's test database, plus what this kit needs on top of it.
 *
 * Import this from any test that touches the database. It points the tests at
 * `database/testing.sqlite` rather than the application's own file — one file
 * shared with a running `artisan serve` is a file two processes write at once,
 * and SQLite refuses the second — and builds it from the real migrations the
 * first time.
 */
const connection = app.config.get<string>('database.default', 'sqlite')

app.config.set(`database.connections.${connection}.database`, 'database/testing.sqlite')

await app.make('db').disconnectAll()

const schema = await app.make('db').schema()

/**
 * Migrations run every time; seeders only on a database that was empty.
 *
 * Migrating unconditionally is what keeps this database in step: it applies
 * whatever is pending and says "nothing to migrate" otherwise. Running it only
 * when the database looked new left it stranded the first time somebody ran the
 * tests before generating a migration — the schema was recorded as up to date
 * and the new table never arrived.
 *
 * Seeding is the opposite: it is not idempotent, and running it on every test
 * run would pile up rows until a unique index complained.
 */
const fresh = !(await schema.hasTable('migrations'))
const artisan = app.make('artisan')

await artisan.run(['migrate', '--force'])

if (fresh) await artisan.run(['db:seed'])

/**
 * better-auth's tables are generated, not shipped.
 *
 * What they contain depends on the options and plugins in `config/auth.ts`, so
 * there is no migration to ship that would be right for every application. If
 * the migration has not been written yet, `migrate` above had nothing to apply
 * and every test here would fail on a missing table — which reads as a broken
 * kit rather than a step not taken.
 */
if (!(await schema.hasTable('user'))) {
  throw new Error(
    'The auth tables do not exist yet. Run: bun artisan auth:schema && bun artisan migrate'
  )
}
