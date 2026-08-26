# Collections and helpers

`@elvel/support` is `Str`, `Arr`, `Collection`, and the two traits everything else
is built from. It has no dependencies, and every other package uses it.

```ts
import { collect } from '@elvel/support'

const rows = collect([
  { id: 1, team: 'a', score: 10 },
  { id: 2, team: 'b', score: 30 },
  { id: 3, team: 'a', score: 20 }
])
```

## The one difference from Laravel worth knowing first

Laravel's collection accepts a **string** almost everywhere a value has to be
read out of an item. Here some methods take a string and some take a callback,
and which is which is decided by what TypeScript can check:

```ts
rows.sum((r) => r.score)          // 60   — a callback
rows.avg((r) => r.score)          // 20
rows.max((r) => r.score)          // 30
rows.sortByDesc((r) => r.score)   // a callback
rows.groupBy((r) => r.team)
rows.keyBy((r) => r.id)

rows.pluck('id')                  // [1, 2, 3]        — a key
rows.where('team', 'a')           // ids 1 and 3
rows.firstWhere('team', 'b')      // { id: 2, … }
```

`pluck`, `where` and `firstWhere` take `K extends keyof T`, so a misspelled field
is a compile error. The arithmetic and grouping methods take a function, because a
string there could not be checked against the item's shape at all.
`rows.sum('score')` fails at run time with `key is not a function` — that is the
error to recognise.

## What you get back

Also worth knowing before writing an assertion:

```ts
rows.groupBy((r) => r.team)   // a plain object: { a: [...], b: [...] }
rows.keyBy((r) => r.id)       // a plain object, keys stringified: '1', '2', '3'
rows.chunk(2)                 // Collection<Collection<T>>
rows.partition((r) => r.score > 15)   // a tuple: [Collection, Collection]
```

```ts
const [high, low] = rows.partition((r) => r.score > 15)   // 2 / 1
```

Everything else that returns "a collection" really does — `.all()` gets the array
out, `.count()` the size, `.first()` and `.last()` the ends.

```ts
collect([1, 2, 3, 4, 5])
  .filter((n) => n % 2 === 1)
  .map((n) => n * 10)
  .all()                       // [10, 30, 50]
```

## The rest of the collection

```ts
rows.doesntContain((r) => r.score > 90)
rows.containsOneItem()  rows.containsManyItems()
rows.select(['id', 'name'])       // several keys per item, where pluck takes one
rows.before(item)  rows.after(item)   // a value or a predicate
rows.splitIn(3)                   // groups filled in turn
rows.multiply(2)
rows.hasSole()  rows.firstOrFail()
```

`split(3)` balances three groups; `splitIn(3)` fills each before starting the next.
Laying out columns wants the first, paging wants the second.

::: warning `splice` and `transform` are deliberately absent
Both mutate, which every other method here refuses to do — and the type system
charges for it. A `T[]` parameter or a `(item: T) => T` callback makes `Collection`
**invariant** in `T`, and `Collection<Model>` then stops being assignable to
`Collection<Article>`: adding them broke six unrelated casts in the database
package. `map()` into a new collection says the same thing and keeps the old one.

`before` and `after` take `unknown` rather than `T` for the same reason, with
overloads so a predicate still has its argument typed.
:::

The "strict" names — `containsStrict`, `doesntContainStrict`, `duplicatesStrict` —
are aliases. In PHP the "strict" opts out of `'1' == 1`; there is no loose
comparison here to opt out of, and they exist so an example copies across without a
reader hunting for what changed.

## `Str`

```ts
Str.slug('Hello World, Ada!')          // 'hello-world-ada'
Str.studly('send_welcome_email')       // 'SendWelcomeEmail'
Str.plural('article')                  // 'articles'
Str.limit('a long sentence here', 8)   // 'a long s...'
Str.random(40)                         // even, and rejection-sampled — see below
Str.before / after / afterLast / chopEnd / matchCase / replacePlaceholders
```

```ts
Str.replaceFirst('a', 'b', 'banana')   // 'bbnana'  — and replaceLast/Start/End
Str.replaceMatches(/\d+/g, 'n', 'a1b22')
Str.padBoth('7', 5, '0')               // '00700'   — the odd one goes right
Str.ucwords('hello world')  Str.ucsplit('FooBar')  Str.pascal / pluralStudly
Str.matchAll('a1b22', /\d+/)           // ['1', '22'] — an array, never null
Str.containsAll(text, ['quick', 'fox'])  Str.isUrl(value)  Str.numbers('+62 812')
Str.substrCount('banana', 'an')  Str.substrReplace / reverse / repeat / unwrap
Str.wordWrap(long, 72)  Str.chopStart(path, '/admin')
Str.ltrim / rtrim        // over a set of characters, which String.trim cannot take
Str.toBase64 / fromBase64
Str.password(32)         // from crypto.getRandomValues, not Math.random
```

This was once "the subset the framework itself needs". The scope changed on
purpose: an application reaching for `replaceFirst` and not finding it writes the
four lines every project writes, and the fifth project gets an edge case wrong —
an empty needle, a negative offset, a `match` that answers `null`.

Still absent, each for a reason: `markdown` and `inlineMarkdown` need a parser this
package will not depend on, `apa` encodes one style guide's title-case rules,
`transliterate` needs a Unicode table, and the `freezeUuids` family is a testing
seam that belongs with a design for deterministic ids.

`Str.random` is what mints session identifiers and CSRF tokens, and it throws
away the bytes that would bias the draw. The [security
page](/security/reporting#two-things-the-first-codeql-run-found) has the reason.

**`Str.mask` reads a negative length as PHP's `substr` does** — it stops that many
characters from the *end*, rather than masking that many:

```ts
Str.mask('4111111111111111', '*', 4, -4)   // '4111********1111'
```

That is Laravel's semantics, and the reason to say so out loud is what the other
reading would do: taking `-4` as "mask four characters" leaves the rest of the
card number sitting in your log, and looks plausible enough to ship.

## `Arr`

```ts
Arr.get({ a: { b: [1, 2] } }, 'a.b.1')   // 2 — dot notation, arrays included
Arr.has({ a: 1 }, 'a')                   // true
Arr.only({ a: 1, b: 2, c: 3 }, ['a', 'c'])  // { a: 1, c: 3 }
Arr.set(target, 'user.name', 'Ada')
Arr.forget(target, 'user.name')
Arr.pluck(rows, 'team')        // and Arr.pluck(rows, 'name', 'id') to key it
Arr.wrap(value)                          // always an array
Arr.shuffle(items)                       // Fisher–Yates, not sort(() => Math.random() - 0.5)
```

`Arr.get` is what makes `config('app.name')` work.

::: warning `Arr.set` and `Arr.forget` refuse prototype keys
A segment of `__proto__`, `constructor` or `prototype` throws. Such a key does
not write a property of that name — it walks into `Object.prototype` and writes
*there*, after which every object in the process answers it. PHP arrays have no
prototype, so `data_set` never had to decide this.
:::

## A numeric segment creates an array

```ts
Arr.set({}, 'items.0.price', 9)   // { items: [{ price: 9 }] }, not { items: { '0': … } }
```

PHP cannot tell the two apart, so Laravel never had to choose. Here it matters:
rebuilding `items.0.price` into an object produces something that serialises as
an object, and a validated payload that reaches a database write or a JSON
response in that shape is wrong in a way nothing catches until a user sees it.

## Traits

Two classes rather than traits, since TypeScript has no traits:

```ts
class Report extends Conditionable {}

report
  .when(isAdmin, (r) => r.withTotals())
  .unless(isDraft, (r) => r.publish())
  .tap((r) => log().info(r.title))
```

```ts
class Formatter extends Macroable {}

Formatter.macro('asCsv', function () { … })   // a plain prototype write
```

`Macroable` is how a package bolts a method onto something it does not own — the
way Laravel packages extend `Str` or the query builder. Types are opt-in through
declaration merging, and the runtime side is a prototype write rather than a
proxy, so nothing pays for it on every property access.
