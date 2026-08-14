# Known gaps

What Laravel has and this does not.

**A row is removed when the thing is built. It is never narrowed.** Rewriting a
row to describe the leftover keeps the list the same length while the work gets
done, which makes the list useless as a measure — and that is exactly what it is
for. When the table empties, the file goes; git history keeps these rules for the
next time there is real debt to count.

**A row whose answer is "this is not actually missing" does not belong here.**
Behaviour that exists and is merely surprising belongs in `BEHAVIOURS.md`, as do
the limits that are permanent.

**Open: 5.**

---

## How this was measured

Against `laravel/framework` **master**, on **14 August 2026**, at the level of
components rather than methods. To repeat it:

```sh
gh api repos/laravel/framework/contents/src/Illuminate --jq '.[] | select(.type=="dir") | .name'
ls packages
```

Laravel ships 38 components; 30 are covered here, several under different names —
`Foundation`+`Container`+`Config` → `core`, `Filesystem` → `storage`,
`Routing`+`Cookie`+`Session` → `http`, `Bus` → `queue/bus.ts` and `batch.ts`,
`Redis` → `cache`, `Pagination` → `database`,
`Collections`+`Macroable`+`Conditionable` → `support`. The scheduler is its own
package here and lives inside `Console` there.

**Not yet measured: depth.** This compares components, not what is inside them —
how many query-builder methods, validation rules or Blade directives Laravel has
that this does not is unknown. That is a larger piece of research and belongs
here as rows when it is done, not as a guess now.

## Missing

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |
| **Testing** | `TestResponse`, `assertStatus`, `assertJson`, `actingAs`, `AssertableJson`, `PendingCommand`, `TestView`, and a parallel runner. | The largest of these by some margin. What exists here is per-package fakes — `events`, `mail`, `notifications`, `storage` — and no idiomatic way to press a route and assert on the response. That absence shaped the suite: thick in unit tests, thin in feature tests, with the playground reaching for raw `fetch`. Building this is what would let a feature test be the cheap thing to write. |
| **Process** | `Factory`, `PendingProcess`, `Pool`, `InvokedProcessPool`, and fakes (`FakeProcessSequence`, `FakeProcessResult`, `FakeProcessDescription`). | `Bun.spawn` is called directly in `scheduler/spawn.ts` and `database/console/schema-dump.ts` — no abstraction, no pool, and nothing to fake against, so anything spawning a process is untestable without spawning it. |
| **Hashing** | `Hash::make()` / `Hash::check()` / `Hash::needsRehash()` over bcrypt and argon2. | better-auth hashes passwords internally, so authentication is covered, but there is no way to hash anything that is *not* a password. Cheap on Bun: `Bun.password` is already argon2id and bcrypt. |
| **Pipeline** | `Pipeline::send()->through()->then()`, used across the framework. | Not present as an abstraction. The pattern is used — a local `reduceRight` at `queue/runner.ts:204` builds the job middleware chain, and HTTP middleware rides Elysia's hooks — but it cannot be borrowed for anything else. |
| **JsonSchema** | A schema builder (`ObjectType`, `ArrayType`, `AnyOfType`, `UnionType`) with a serializer and deserializer. | Closer than it looks: `validation` is built on TypeBox, which already *is* JSON Schema. What is missing is the builder surface and the round trip, not the representation. |

## Considered and declined

Not counted above, and not to be re-derived. Each was checked against Laravel's
source on the date above.

- **Concurrency** — `ConcurrencyManager` with `Fork`, `Process` and `Sync`
  drivers. It exists because PHP cannot await; `Promise.all` and Bun's `Worker`
  answer the same need without a component. Reconsider only if something needs
  real CPU parallelism.
- **Image** — `ImageManager` over GD/Imagick/Intervention with twelve
  transformations. A large surface wrapping a native library that Bun has no
  equivalent of, and Laravel itself only added it recently. Not worth the weight
  unless an application asks.
- **Reflection** — `Reflector` inspects parameter types to autowire. TypeScript
  erases types at runtime, so this cannot be copied; the container here resolves
  by token instead, deliberately. Copying the approach would be the mistake.
