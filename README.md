# Elvel

Laravel's structure and developer experience, built on [Elysia](https://elysiajs.com)
and Bun.

**Status: alpha, published on npm.** Twenty-seven packages, released together and
versioned in lockstep, each carrying a provenance attestation linking it to the
commit and workflow that built it — see
[the releases](https://github.com/ufhy/elvel/releases) for the current one. Every package the roadmap named is built; the API is still free to
change between alphas.

## Documentation

**[ufhy.github.io/elvel](https://ufhy.github.io/elvel/)** — installation, the
starter kits, configuration, routing, views, the database, validation, the
cache, queues, scheduling, the console, mail, notifications, file storage,
encryption, testing, and how to work on the framework itself.

It is built from `apps/docs`, so it ships in the same commit as the code it
describes and cannot drift into describing a version that never existed. Nineteen
of the twenty-seven packages have a page; the rest arrive one at a time, and a page
appears only once it has something true to say.

## Quick start

```bash
bun create elvel my-app     # --kit=none | auth | api
cd my-app
bun elvel serve
```

`bun elvel` lists every command. The
[installation page](https://ufhy.github.io/elvel/getting-started/installation)
has the rest.

## Packages

| Package | Contents |
| --- | --- |
| `@elvel/contracts` | Interfaces only. Breaks dependency cycles between packages. |
| `@elvel/support` | `Str`, `Arr`, `Collection`, `Macroable`, `Conditionable`. |
| `@elvel/core` | `Application`, `ServiceProvider`, `Config`, `Env`, exception handler, `controller()`, helpers. |
| `@elvel/database` | Connections, query builder, models, schema builder and migrator on Bun.SQL. |
| `@elvel/http` | `FormRequest`, `JsonResource`, sessions, signed and encrypted cookies, CSRF, rate limiting, CORS, trusted proxies. |
| `@elvel/validation` | Two-phase validation: ~50 rules, `unique`/`exists`, error bags. |
| `@elvel/events` | Dispatcher with wildcards, halting, subscribers, `EventFake`. |
| `@elvel/log` | Channels and drivers (console, json, single, daily, stack, null). |
| `@elvel/console` | The CLI: signature parser, command base, kernel, stub generators. |
| `@elvel/view` | JSX renderer (`@kitajs/html`), `view()`/`render()` helpers, static file serving. |
| `@elvel/auth` | better-auth over our own query builder, plus Gate and policies. |
| `@elvel/cache` | Four stores (array, file, database, redis) with atomic locks, tags and a rate limiter. |
| `@elvel/queue` | Jobs, three drivers, worker with Laravel's retry policy, chains, failed jobs. |
| `@elvel/scheduler` | Cron matcher, `withoutOverlapping`, timezones, `schedule:run`/`schedule:test`. |
| `@elvel/mail` | Mailables, nodemailer transports, queued mail. |
| `@elvel/storage` | Disks (`local`, `s3` on Bun.S3Client), path guard, offline presigned URLs. |
| `@elvel/notifications` | Channels (mail, database, log), per-recipient ids, on-demand recipients. |
| `@elvel/encryption` | AES-256-GCM, HKDF-derived keys, context binding, key rotation, `key:generate`. |
| `create-elvel` | Application skeleton scaffolder. |

## Behaviours and limits

[`BEHAVIOURS.md`](BEHAVIOURS.md) explains the decisions that are easy to misread
from the outside — why a cancelled batch never finishes, why a `..` that stays
inside a disk is allowed, why the day-of-month rule is POSIX's and not the
obvious one.

Its last section is where the framework stops: what the tests do not reach and
why, and the one feature that was attempted and could not be made to work
(compile-time XSS checking, blocked by a TypeScript 7 incompatibility in
`@kitajs/ts-html-plugin`).

## Security

Found a hole? **Do not open an issue.** Report it privately through
[GitHub's advisory form](https://github.com/ufhy/elvel/security/advisories/new),
or by email to `suryadi.tahir@kalla.co.id`. [SECURITY.md](SECURITY.md) says what
is in scope and what to include.

Every push runs CodeQL and `bun audit`; secret scanning with push protection is
on. `BEHAVIOURS.md` records what the first CodeQL run found.

## Roadmap

The roadmap agreed at the start is complete: core, console, view, events, log,
database, validation, http, auth, cache, queue, scheduler, mail, storage,
notifications, and the encryption package the last three items were waiting on
(encrypted cookies, encrypted queue payloads, encrypted model casts).

Where each package stops — and why — is in
[`BEHAVIOURS.md`](BEHAVIOURS.md).

What is left is not features. Two things worth knowing before depending on this:

**Packages ship TypeScript source**, so your `tsc` compiles their internals. That
makes the types exact and it makes our problems yours: `@elvel/mail` imported an
untyped subpath and applications that installed it failed their own typecheck
while ours passed, because the types sat in this repository's root. Building each
package to one file would end that class of bug, and measured, it also made boot
35 to 40 per cent *slower* — so it is not done, and `BEHAVIOURS.md` has the
numbers.

**Nothing here has run in production.** The suite covers SQLite, Postgres and
MySQL, the queue drivers, and both caches, and the smoke run drives a real
application over a socket. None of that is the same as a year of somebody else's
traffic.
