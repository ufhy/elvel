# Validation

Two phases, because TypeBox has no async path and no `refine` — this is a
constraint, not a preference.

**Phase one is the Elysia `body` schema**: shape, type and format, checked
synchronously before the handler runs, and the same schema that produces the
OpenAPI document.

**Phase two is `validator()`**: everything TypeBox cannot express.

```ts
const check = validator(body, {
  name: 'required|string|min:2',
  email: ['required', 'email', Rule.unique('users', 'email').ignore(user.id)],
  password: 'required|min:8|confirmed',
  team: 'required_if:role,admin'
})

const data = await check.validate()   // throws ValidationError with the bag
```

The execution model follows `Illuminate\Validation\Validator::passes()`, and the
details are what make an error bag readable rather than noisy:

- a rule runs only if the value is present or the rule is **implicit** (the 24
  `required*`/`present*`/`accepted*` rules), so `required` can fail on a key that
  was never sent
- an implicit failure **stops the remaining rules for that attribute** — an empty
  field reports "required" alone, not also "min" and "email"
- a whitespace-only string counts as absent
- `nullable` lets an explicit null through, `sometimes` skips an absent key,
  `bail` stops at the first failure
- `exclude_if` and friends **drop the attribute** instead of failing it
- `validated()` returns only what was validated, so an unchecked field cannot
  reach a database write

`unique` and `exists` read the database through a `PresenceVerifier`, which is an
interface: `@elvel/validation` has **no dependency** on `@elvel/database`, and
the two rules explain themselves if no verifier is available. Both support the
string form (`unique:users,email,ignoreId,idColumn`) and the object form with
extra constraints (`Rule.unique('users','email').where('tenant', id)`).

`FormRequest` is deliberately *not* here: it needs the request context and
session, so it belongs to the `http` package. This one works in a command or a
seeder with no HTTP at all.
