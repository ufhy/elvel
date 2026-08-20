# Gaps

Only what must still be built. A row is **deleted** when the work lands, never
narrowed — so the length of this file measures the work left, and a file that
cannot shrink measures nothing.

Behaviour that already exists and would otherwise be rediscovered through a bug
belongs in `BEHAVIOURS.md` instead, along with the places the framework
deliberately stops. The test to apply when something turns up: *is there
something to build?* If no, it is not a row here. Mixing the two is what once
kept a gap list from ever shortening while dozens of features shipped.

The row below came out of `BEHAVIOURS.md`, which had been quietly carrying it as
prose. The one that stood beside it — no test for a scaffold installed from npm —
is gone, because `scripts/verify-published.ts` now runs in `release.yml` after
the publish and found a real bug on its first run.

---

## `sessions.last_activity` runs out in 2038

`packages/http/stubs/sessions-table.stub` declares `table.integer('last_activity')`,
matching Laravel. It holds a unix timestamp, so it is correct until January 2038
and then it is not — the same shape as the cache's `expiration` bug that Postgres
and MySQL caught, and that one was found by a test rather than by a date.

`bigInteger` already exists in the blueprint, so the change itself is one word in
the stub and one in `packages/http/test/session-drivers.test.ts`. What makes it a
row rather than a rename is everything around it: a stub only affects
applications scaffolded after it changes, so existing installations keep the
32-bit column and need a migration written for them, and the sweep in
`session-drivers.ts` compares against the same column on every request.

**Done when** the stub emits a 64-bit column, the driver's tests exercise a
timestamp beyond 2038 on SQLite, Postgres and MySQL — the three that disagree
about integer widths — and the release notes say what an existing application has
to run.
