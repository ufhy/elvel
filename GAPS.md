# Known gaps

What is deliberately missing, per package, so it is not rediscovered by
accident. Everything here is a decision, not an oversight; where something was
attempted and could not be made to work, that is said plainly.

**A row is removed when the thing is built. It is never narrowed.**
If part of a feature is done, the row goes and what remains is either a new row
naming something genuinely different, or nothing at all. Rewriting a row to
describe the leftover keeps the list the same length while the work gets done,
which makes the list useless as a measure — and that is exactly what it is for.

**A row whose answer is "this is not actually missing" does not belong here.**
Eight have been written and then removed on those grounds; the last four named
`FormRequest`, `sessionOf()`, `fileResponse()` and a transaction arrangement that
already works. Behaviour that exists and is merely surprising belongs in
`BEHAVIOURS.md`, which is where the per-package notes moved so that this file
shortens when work is finished.

Reviewed against the Laravel 13 documentation and, where behaviour mattered, the
`laravel/framework` source.

Every row was last checked against the code on 2026-08-13: each one's API was
grepped for in `packages/*/src`. Rows that named something already implemented
were removed — `Model::withoutTimestamps`, `Log::withoutContext`,
`connection.transactions.level`, a duplicate pair about console prompting, and
the four named above.

---

## @elysian/database — complete for this milestone

The query builder, schema builder, migrator and model layer cover the documented
Laravel surface that applies to this runtime, and are tested against **SQLite,
Postgres 17 and MySQL 9**.

Deliberately absent, with reasons:

| Missing | Why |
| --- | --- |
| Vector/similarity clauses (pgvector) | Needs its own grammar and the pgvector extension. |
| `morphToMany` **through** another relation | Reaching a morph pivot via a second relation is a join shape nothing here composes yet. |

---

## @elysian/view

| Missing | Why |
| --- | --- |
| Vite integration, asset versioning | The static plugin serves `public/`; there is no manifest reader. |

## @elysian/events

Wildcards, halting, subscribers, `push`/`flush`, a fake — and listeners that run in
a worker instead of the request.

| Missing | Why |
| --- | --- |
| Broadcasting | Needs a driver and a socket layer. |

## @elysian/log

| Missing | Why |
| --- | --- |

## @elysian/validation

| Missing | Why |
| --- | --- |

## @elysian/http

`FormRequest`, `JsonResource`, sessions, signed and encrypted cookies, CSRF, rate
limiting, CORS and trusted proxies.

| Missing | Why |
| --- | --- |

## @elysian/auth

better-auth 1.6.27 owns credentials, sessions, providers and the endpoints that
go with them. This package supplies the adapter that puts its tables on our
connection, the request scope that makes the current user reachable, and the Gate
and policies on top.

| Missing | Why |
| --- | --- |

## @elysian/queue

Three drivers — `sync`, `database`, `redis` — a worker whose retry policy is
transcribed step for step from `Illuminate\Queue\Worker`, chains, job middleware,
a failed-job store, and `defer()` for work too small to queue.

| Missing | Why |
| --- | --- |

## @elysian/mail

Mailables with an envelope, content and attachments; transports for SMTP, Resend,
Postmark, Mailgun, log and array, plus `failover` and `roundrobin`; queued mail
through the queue package; and `Mail.fake()` for tests.

| Missing | Why |
| --- | --- |
| Markdown mailables | Needs a markdown parser and a theme to render into. HTML mail here is a JSX view, which is the same renderer the web views use — no second template engine, and the props are typechecked. |

## @elysian/storage

Disks for `local`, `s3` and `memory` behind one contract, with `storage:link`,
streamed downloads and a path guard. The S3 driver is Bun's native client — no SDK,
and presigning needs no network.

| Missing | Why |
| --- | --- |

## @elysian/notifications

One notification, several channels — `mail`, `database` and `log` — with `via()`
deciding per recipient, on-demand recipients, queued delivery, an inbox model and a
fake.

| Missing | Why |
| --- | --- |
| `broadcast` channel | Needs a websocket package, which does not exist yet. It is the one channel that cannot be a few lines of `fetch`. |
| Markdown notification templates | The `MailMessage` builder renders to HTML here, inline-styled, because a mail client ignores most of a stylesheet. `view()` hands the body to one of the application's own JSX components when the default is not enough. |

## @elysian/encryption

| Missing | Why |
| --- | --- |

## Not started

Every package on the roadmap is built — core, console, view, events, log,
database, validation, http, auth, cache, queue, scheduler, mail, storage,
notifications, and the encryption package the last three items were waiting on.

Delivery is done too: the scaffolder ships all of them, and a scaffolded
application boots every provider without a service running. What remains is in
the per-package tables above — starter-kit views being the largest of it.

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
