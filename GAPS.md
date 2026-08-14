# Known gaps

**There are none left in the per-package tables.** Every row that once stood
here has been built, or was deleted because it named something that already
existed. What remains below is a watch list and the places the test suite does
not reach — neither of which is a missing feature.

This file is kept because the next gap belongs here, and because the rules it
was given are worth keeping:

**A row is removed when the thing is built. It is never narrowed.** Rewriting a
row to describe the leftover keeps the list the same length while the work gets
done, which makes the list useless as a measure — and that is exactly what it is
for.

**A row whose answer is "this is not actually missing" does not belong here.**
Forty-five were written and then removed on those grounds. Behaviour that exists
and is merely surprising belongs in `BEHAVIOURS.md`.

Reviewed against the Laravel 13 documentation and, where behaviour mattered, the
`laravel/framework` source.

---

## Not started

Nothing.

Every package on the roadmap is built — core, console, view, events, log,
database, validation, http, auth, cache, queue, scheduler, mail, storage,
notifications, translation, broadcasting, and encryption.

Delivery is done too: the scaffolder ships all of them, a scaffolded application
boots every provider without a service running, and the auth starter kit
scaffolds its own sign-in, sign-up and dashboard pages.

## Watch list

- **`sessions.last_activity` is a 32-bit integer**, like Laravel's. It holds a
  unix timestamp, so it is correct until 2038 and then it is not — the same shape
  as the cache's `expiration` bug that Postgres and MySQL caught. Left alone for
  now because nothing writes a value beyond the range today; worth widening the
  next time that table changes.
- `node_modules/.bun` holds **two copies of elysia 1.4.29** under different peer
  hashes. Nothing misbehaves today, but dual module identity is exactly what the
  `file:`-dependency episode was about, and Elysia deduplicates plugins by name
  within one module instance. Worth collapsing if plugin registration ever gets
  strange.

## Test coverage gaps

`bun test --coverage` reports roughly three quarters of functions. Known
uncovered, and why:

- terminal formatting (`output.ts`, `about.ts`, `db:show`, `db:table`) — the
  smoke test asserts the text that matters; pinning colour codes would test
  `picocolors`
- `serve.ts` — its `handle()` never resolves by design; the smoke test binds a
  real socket instead
- `create-elysian` — covered end to end by the smoke test rather than by units:
  it scaffolds, boots, and every package's commands are registered in what it
  wrote. Not covered is a scaffold installed *from npm* rather than resolved
  through the workspace
- MySQL/Postgres **grammar** paths that the dialect suite does not reach, such as
  `insertGetId` on MariaDB
- the S3 disk against AWS itself — the round trip is covered against MinIO
  (`TEST_S3_ENDPOINT`), which is the same protocol, but not against S3's own
  eventual-consistency and region behaviour
- the `sqs` driver against AWS itself — the round trip is covered against
  ElasticMQ, which speaks the same query protocol and the same SigV4, but not
  against AWS's own eventual consistency, its 120,000 in-flight limit, or FIFO
  queues
- the queue's `redis` driver against a cluster; single-node Redis is covered, and
  the database driver is covered on SQLite, Postgres 17 and MySQL 9 including the
  two-workers-race case that only a real server can exercise
- better-auth **plugin** schemas against real servers — the adapter itself is
  covered on SQLite, Postgres 17 and MySQL 9 by `packages/auth/test/dialects.test.ts`,
  but only for the four core tables
