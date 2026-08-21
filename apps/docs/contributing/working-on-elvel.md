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

## Testing a generator, not the query layer

Two bugs have hidden behind the same mistake, so it is worth stating as a rule.

A suite that **constructs** the schema it wants to test proves the query layer and
nothing about the code that generates schemas. The auth adapter's dialect tests
built their tables by hand with `blueprint.text('token')`, so the migration
`auth:schema` actually writes had never been executed against MySQL — only
rendered and string-matched. It turned out to be illegal there:
`BLOB/TEXT column 'token' used in key specification without a key length`, for
every application, on the second table.

The same shape produced the other one: a stub that dispatched events by the
object's own `name` field rather than the way the real dispatcher does, which hid
`Model.observe()` doing nothing at all.

So when the thing under test is a generator:

- write what it generated to disk, import it, and **run** it
- write it inside the workspace, or its own imports will not resolve
- exercise the reverse too — `down()` is half of what makes a migration
  deployable
- go through the real adapter, not the query builder underneath it. A raw insert
  bypasses the conversions each dialect needs; the first version of the plugin
  test handed sqlite a `Date` and got
  `Binding expected string, TypedArray, boolean, number, bigint or null`

And when a package cannot depend on what it needs to test against — as
`@elvel/database` cannot depend on `@elvel/events` — the stub belongs there and
the agreement belongs in `playground/test`, where every provider is really
registered.
