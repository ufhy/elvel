import app from '../bootstrap/app.ts'

/**
 * Point the tests at a database of their own, and build it if it is not there.
 *
 * Import this from any test that touches the database. Two reasons, and the
 * second is the one that bites:
 *
 * A checked-out project has no `database/*.sqlite` — the database is its
 * migrations, not a file somebody committed — so the first test run has nothing
 * to query. This runs the real migrations and seeders once, at import, and only
 * when the schema is missing.
 *
 * And a single file shared between the tests, a running `artisan serve` and
 * whatever else is open is a file two processes write at once. SQLite lets one
 * writer in and refuses the other, so a whole suite fails together with
 * `database is locked` in a way that reads like a bug in every test. A database
 * of its own is what stops it.
 */
const connection = app.config.get<string>('database.default', 'sqlite')

app.config.set(`database.connections.${connection}.database`, 'database/testing.sqlite')

// Nothing has opened it at import time; this is belt and braces against a
// provider that decides to connect during boot one day.
await app.make('db').disconnectAll()

const schema = await app.make('db').schema()

/**
 * `migrations` rather than a table of your own: it is the one table that exists
 * in every application, and its absence is what "this database is empty" means.
 */
if (!(await schema.hasTable('migrations'))) {
  const artisan = app.make('artisan')

  await artisan.run(['migrate', '--force'])
  await artisan.run(['db:seed'])
}
