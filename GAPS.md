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

**Open: 11.**

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

### HTTP

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |
| **View helpers Blade has** | `@error`, `@auth`, `@guest`, `@can`, `@stack`/`@push`, `@once`. | Only `csrfField()` exists. `@stack`/`@push` is the one with no JSX workaround — a page cannot contribute to the layout's `<head>`. |

### Support

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |

### Database

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |
| **Query builder methods** | 226 public methods. | 121 here. Missing and genuinely used: `cursor`, `average`, `inRandomOrder`, `groupByRaw`, `havingBetween`, `havingNull`/`havingNotNull`, `joinLateral`, `fromSub`, `crossJoinSub`, `insertUsing`, `incrementEach`/`decrementEach`, `forPageAfterId`, `implode`, `inOrderOf`. |
| **Model methods** | `destroy`, `deleteOrFail`, `saveOrFail`, named scopes via `callNamedScope`, `getRouteKey`, `broadcastChannel`, `automaticallyEagerLoadRelationships`. | The named-scope surface and `destroy` are the ones an application reaches for daily. |

### Framework services

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |
| **Cache** | `getMultiple`, `setMultiple`, `deleteMultiple`, `touch`, `supportsTags`, `rememberWithWarmth`. | The PSR-16 multi-key methods are the gap that shows: fetching fifty keys is fifty round trips today. |
| **Storage** | `assertExists`, `assertMissing`, `assertCount`, `assertDirectoryEmpty`; `temporaryUrl`, `temporaryUploadUrl`, `checksum`, `download`, `response`, `serve`, `directoryExists`. | The assertions belong with the testing work; `temporaryUrl` is what a private S3 file needs to reach a browser at all. |
| **Mailable assertions** | 30-odd `assertHasTo`, `assertHasSubject`, `assertSeeInHtml`, `assertHasAttachment`, … | The mail fake records sends; nothing asserts what was in one. |

### Artisan

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |
| **~44 commands of 111** | Counted from `ArtisanServiceProvider`. | Notable: `make:test`, `make:rule`, `make:cast`, `make:observer`, `make:enum`, `make:exception`, `optimize`, `optimize:clear`, `route:cache`/`route:clear`, `view:cache`, `event:cache`, `config:show`, `env:encrypt`/`env:decrypt`, `db:wipe`, `db:monitor`, `model:show`, `model:prune`, `queue:listen`, `queue:monitor`, `queue:pause`/`resume`, `schedule:interrupt`, `vendor:publish`, `lang:publish`. |
| **Validation rules — 18 of 110** | Verified one by one after normalising. | `active_url`, `ascii`, `doesnt_contain`, `doesnt_end_with`, `doesnt_start_with`, `hex_color`, `mac_address`, `max_digits`, `min_digits`, `multiple_of`, `timezone`, `ulid`, `ipv4`, `encoding`, `array_keys`, `in_array_keys`, `prohibited_if_accepted`, `prohibited_if_declined`. |

### The scaffolded application

Found by scaffolding one and following the printed instructions.

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |
| **Two manual steps before the kit works** | The installer prompts for a database and offers to migrate. | `auth:schema` and `migrate`, by hand. Down from three now the secrets are generated, and the remaining two cannot be run by the scaffolder in workspace mode: the framework packages are not linked until `bun install` runs at the repository root, so artisan cannot start. Laravel's installer runs `composer install` itself, which is what closing this would take. |

### The auth kit

| Gap | What Laravel has | Why it matters here |
| --- | --- | --- |
| **Email re-verification on change** | `ProfileController::update` clears `email_verified_at` when the address is dirty. | The kit sends the new address to better-auth and does not check what it does with verification state. |
| **Password confirmation window** | `RequirePassword` middleware guards the security page; `password.confirm` re-asks within a window. | Absent. The kit asks for a password on account deletion only, which was my judgement rather than Laravel's design. |

## Not yet measured

Named so the list is not mistaken for complete: events beyond the dispatcher,
queue job internals (the raw diff there is mostly PHP-isms and needs reading, not
counting), notifications channels, translation, broadcasting, encryption, the
scheduler's expression surface, and Blade's directive set as a whole rather than
the six helpers named above.
