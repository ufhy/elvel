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

**Open: 3.**

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
`Collections`+`Macroable`+`Conditionable`+`Pipeline` → `support`. The scheduler is its own
package here and lives inside `Console` there.

**Not yet measured: depth.** This compares components, not what is inside them —
how many query-builder methods, validation rules or Blade directives Laravel has
that this does not is unknown. That is a larger piece of research and belongs
here as rows when it is done, not as a guess now.

## Missing

Three rows that were once declined on my judgement. That judgement was
overridden: they are being built, so they belong here where they can be counted
and removed rather than in a list of settled decisions.

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |
| **Concurrency** | `ConcurrencyManager` with `Fork`, `Process` and `Sync` drivers, plus `InvokeSerializedClosureCommand`. | It exists in PHP because PHP cannot await, and `Promise.all` covers most of what it is used for. What it does *not* cover is real CPU parallelism: `Worker` is available and nothing here uses it, so a caller with work to spread across cores has to build the plumbing. |
| **Image** | `ImageManager` over GD/Imagick/Intervention, with twelve transformations (`Resize`, `Cover`, `Crop`, `Blur`, `Grayscale`, `Orient`, …). | The largest of the three, and the one with no native library behind it on Bun. Whatever is built will have to be honest about what it can and cannot do without one. |
| **Reflection** | `Reflector`, which inspects parameter types to autowire. | Cannot be copied: TypeScript erases the types it would inspect. What can be built is the useful half — inspecting what a class and its methods actually expose at runtime — and the row stays until that exists or is proven pointless. |
