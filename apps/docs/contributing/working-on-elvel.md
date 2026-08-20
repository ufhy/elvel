# Working on Elvel

Working on the framework itself rather than on an application built with it:

```bash
git clone https://github.com/ufhy/elvel
cd elvel
bun install
bun run verify   # lint -> typecheck -> test -> smoke. Run this on every change.
```

To scaffold an application *inside* the checkout, against the packages you are
editing rather than the published ones:

```bash
bun run create apps/blog
bun install                # link the new workspace member
cd apps/blog && bun run dev
```

A scaffold inside the checkout becomes a workspace member and resolves
`@elvel/*` by symlink. That is convenient and it hides things: a manifest is only
ever exercised by somebody else's install, which is how a published release once
went out declaring none of the packages its own source imported.
`tests/publishable.test.ts` checks the manifests directly for that reason.

Individually:

```bash
bun run lint
bun run typecheck
bun run test     # 2,462 tests, including those against real Postgres and MySQL
bun run smoke    # 783 checks against the real playground app
```

### playground/

`playground/` is a tracked workspace member — the same skeleton `bun run create`
produces, plus an `ExerciseController`, an `exercise.tsx` view (with an async
component and a deliberately unsafe-looking prop), and a `Ping` command that
exist purely to give the smoke test something real to assert against.

```bash
bun run playground:dev              # serve it with --watch
bun run playground route:list       # any Elvel command
bun run playground:reset --force    # regenerate from the template (destructive)
```

Because the framework packages are linked by symlink, editing `packages/*` takes
effect in the playground immediately — which is the point: `bun run smoke` boots
this app, renders its views, runs its commands, generates code into it (then
cleans up), scaffolds a throwaway project, and binds a real socket. A broken
template or stub fails there even when every unit test still passes.

`tests/fixture` is a separate, minimal application used by the automated
integration tests; the playground is for end-to-end checks and manual poking.

### Test coverage

`bun test --coverage` reports **74% of functions / 85% of lines**. Every package
has unit tests except `contracts` (interfaces only, no runtime) and
`create-elvel` (covered end to end by the smoke test).

Deliberately not unit-tested:

- `output.ts` and `about.ts` — terminal formatting; the smoke test asserts the
  text that matters, and pinning colour codes would test `picocolors`.
- `serve.ts` — its `handle()` never resolves by design; the smoke test binds a
  real socket instead.
- `command.ts` accessors — exercised through the kernel and generator tests
  rather than in isolation.
- `str.ts` inflection edge cases beyond the common forms.
