# Gaps

Only what must still be built. A row is **deleted** when the work lands, never
narrowed — so the length of this file measures the work left, and a file that
cannot shrink measures nothing.

Behaviour that already exists and would otherwise be rediscovered through a bug
belongs in `BEHAVIOURS.md` instead, along with the places the framework
deliberately stops. The test to apply when something turns up: *is there
something to build?* If no, it is not a row here. Mixing the two is what once
kept a gap list from ever shortening while dozens of features shipped.

Both rows below came out of `BEHAVIOURS.md`, which had been quietly carrying them
as prose.

---

## A scaffold installed from npm is not tested at all

`bun run smoke` scaffolds an application and boots it, and `packages/create-elvel/test`
covers what the scaffolder writes — but both resolve `@elvel/*` through the
workspace. A workspace member never resolves a published version, so an entire
class of error is invisible to every check that runs.

That is not hypothetical. `1.0.0-alpha.1` went out with `create-elvel` writing
`^0.0.1` as the dependency range for every framework package. Nothing caught it,
and it took a second release the same day to fix. Since then the check has lived
in a habit: after each release I run `bunx create-elvel@<version>` by hand,
confirm the ranges name the version just published, migrate, and fetch the
welcome page. A check that exists only in somebody's habit is not a check.

**Done when** a test installs the scaffolder from the registry rather than the
workspace, scaffolds with it, and asserts the dependency ranges resolve to real
published versions — then boots what it wrote. It cannot run on every push, since
it needs a published version to point at, so it belongs after the publish step in
`release.yml`, where a failure still precedes the announcement. `--dry-run` needs
an answer too: with nothing published there is nothing to install, and the honest
move is to skip loudly rather than pass quietly.

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
