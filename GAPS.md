# Known gaps

What Laravel has and this does not — measured at method level, not component
level.

**A row is removed when the thing is built. It is never narrowed.** Rewriting a
row to describe the leftover keeps the list the same length while the work gets
done, which makes the list useless as a measure — and that is exactly what it is
for. When the table empties, the file goes; git history keeps these rules for the
next time there is real debt to count.

**A row whose answer is "this is not actually missing" does not belong here.**
Behaviour that exists and is merely surprising belongs in `BEHAVIOURS.md`, as do
the limits that are permanent.

**Open: 0.**

---

## How this was measured

Against `laravel/framework` **13.25.0** and `laravel/fortify`, on **14 August
2026**. The earlier sweep compared *components* and found 30 of 38 covered; this
one compares what is inside them, which is where the real distance turned out to
be.

The method, repeatable:

```sh
# every public method of a Laravel class
gh api repos/laravel/framework/contents/src/Illuminate/Collections/Collection.php \
  --jq '.content' | base64 -d | grep -oE "public (static )?function [a-zA-Z_]+" \
  | sed 's/.*function //' | sort -u
```

…then the same for ours, and diff. **Normalise before diffing**: Laravel's
`requiredIf` is our `required_if`, and a first pass that skipped this reported 52
missing validation rules where there are 18.

**Raw counts overstate.** A diff of method names counts PHP-isms nobody wants
(`offsetGet`, `getQueueableId`, `cleanBindings`, `dd`) and counts a method we
implement under another name. Every row below names what is actually missing
rather than quoting the raw difference; where a count appears, it has been
checked item by item.

## Missing

Nothing. Every gap this sweep measured has been built; the rules above stay so
the next sweep has them.

## Not yet measured

**This is the only reason the file is still here.** Every row that was measured
has been built; what follows has never been swept at method level, and naming it
is what stops the empty table above being read as "there is nothing left".

- Queue job internals — the raw diff is mostly PHP-isms and needs reading, not
  counting
- Notification channels
- Translation
- Broadcasting
- The scheduler's expression surface
- Blade's directive set as a whole, rather than the six helpers that were named

Sweeping any of these means the `gh api` recipe above, normalising the names, and
adding rows for what is genuinely absent. When one is swept, take it off this
list — the same rule as the table.
