import app from '../bootstrap/app.ts'

/**
 * Point the tests at their own database, and build it if it is not there.
 *
 * Two reasons, and the second is the one that bites. The database is not
 * committed — it is its migrations plus its seeders, and a binary that changes
 * on every run had put itself into 76 commits before anybody looked — so a fresh
 * clone has nothing to query. And a single file shared between the tests, a
 * running `elvel serve` and `bun run smoke` is a file two processes write at
 * once: SQLite refuses the second outright, and fifteen tests fail together with
 * `database is locked` in a way that reads like fifteen separate bugs.
 *
 * Laravel's answer is the same one: a database of its own for testing.
 *
 * Everything else about the connection is left as the application configured it,
 * so what the tests exercise is the application's own settings and not a second
 * arrangement that only exists here.
 */
const connection = app.config.get<string>('database.default', 'sqlite')

app.config.set(`database.connections.${connection}.database`, 'database/testing.sqlite')

// Nothing has opened it yet at import time; dropping any connection is belt and
// braces against a provider that decides to connect during boot one day.
await app.make('db').disconnectAll()

const schema = await app.make('db').schema()

if (!(await schema.hasTable('articles'))) {
  const elvel = app.make('elvel')

  await elvel.run(['migrate', '--force'])
  await elvel.run(['db:seed'])
}
