import app from '../bootstrap/app.ts'

/**
 * Build the playground's database if it is not there yet.
 *
 * The database is not committed — it is its migrations plus its seeders, and a
 * binary that changes on every run had put itself into 76 commits before anybody
 * looked. So a fresh clone has no `database/playground.sqlite`, and something has
 * to make one before a test can ask `Article.query().find(1)`.
 *
 * Importing this module is that something. It runs at import time, once per test
 * process, and only when the schema is actually missing — so the ordinary case,
 * where the file already exists, costs one `hasTable` and nothing else.
 *
 * The real migrations and the real seeders, deliberately. A helper that created
 * the tables itself would be a second definition of the schema, and the day it
 * drifted from `database/migrations` the tests would pass against a database no
 * application could have.
 */
const schema = await app.make('db').schema()

if (!(await schema.hasTable('articles'))) {
  const artisan = app.make('artisan')

  await artisan.run(['migrate', '--force'])
  await artisan.run(['db:seed'])
}
