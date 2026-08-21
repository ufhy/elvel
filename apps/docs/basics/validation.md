# Validation rules

```ts
import { validate } from '@elvel/validation'

const data = await validate(body, {
  title: 'required|min:3',
  email: 'required|email|unique:users,email',
  status: 'required|in:draft,published'
})
```

For an incoming request, a `FormRequest` is usually the better home — see
[Requests and validation](/basics/requests).

## Two phases, and why there are two

**Phase one is TypeBox**, checked synchronously by Elysia before the handler
runs: shape, type, format. **Phase two is this**, and it is everything TypeBox
cannot express — anything asynchronous (`unique`, `exists`) and anything that
reads another field (`confirmed`, `required_if`, and two dozen more).

That split is not a compromise. A schema that has to await a database round trip
is no longer a schema, and a validator that cannot see the rest of the payload
cannot express "required when kind is post".

## The execution model

It follows `Illuminate\Validation\Validator::passes()` exactly, because the
details are what make an error bag readable.

**An empty required field reports one message, not three:**

```
validate({ title: '' }, { title: 'required|min:3|email' })
→ { "title": ["The title field is required."] }
```

Validation for an attribute stops once an **implicit** rule fails, so you are not
told that an empty string is also too short and also not an email address.

The rest of the model:

- a rule runs only if the value is present, or the rule is *implicit*
- `bail` stops that attribute at its first failure
- `exclude*` rules **remove** the attribute from `validated()` rather than failing

```
{ n: 'x' } · 'bail|integer|min:5'   → ["The n field must be an integer."]
```

### `nullable` and `sometimes`

```
{ note: null } · 'nullable|min:5'   → passes
{}            · 'sometimes|min:5'   → passes
```

`nullable` skips non-implicit rules for a null value; `sometimes` skips everything
when the key is **absent**. They are different questions — "may be null" and "may
be missing" — and a payload that distinguishes them needs both.

## Cross-field rules

```
{ password: 'a', password_confirmation: 'b' } · 'required|confirmed'
→ ["The password field confirmation does not match."]

{ kind: 'post', slug: '' } · 'required_if:kind,post'
→ ["The slug field is required when kind is post."]
```

The whole family: `required_if`, `required_unless`, `required_with`,
`required_with_all`, `required_without`, `required_without_all`,
`required_if_accepted`, `required_if_declined`, `required_array_keys` — and their
mirrors `missing_*` and `prohibited_*`, plus `same`, `different`, `confirmed`,
`in_array`, `gt`/`gte`/`lt`/`lte` against another field.

## Arrays and wildcards

```
{ items: [{ price: 1 }, { price: 'no' }] } · { 'items.*.price': 'required|integer' }
→ { "items.1.price": ["The items 1 price field must be an integer."] }
```

The message is keyed by the **expanded** attribute, so a client can point at the
row that failed. The pattern is remembered too: a message or label configured for
`items.*.price` is found from `items.0.price`, and `distinct` knows which
attributes are its siblings.

## Only validated keys come back

```
validate({ title: 'Hi', extra: 'x' }, { title: 'required' })
→ { title: 'Hi' }
```

`extra` is gone. That is what stops a field nobody asked for reaching a database
write — the reason to use `validated()` rather than the raw body.

## Database rules

```ts
'email' => 'unique:users,email'
'email' => 'unique:users,email,' + user.id      // ignore this row, when updating
'author_id' => 'exists:users,id'
```

Asynchronous, which is exactly why they are in phase two.

## `uncompromised` — the one worth knowing about

```ts
{ password: 'required|min:8|uncompromised' }
```

The password must not appear in a known breach, checked against Have I Been Pwned
with **k-anonymity**: only the first five characters of the SHA-1 hash leave the
process, and the service answers with every suffix under that prefix. The password
itself is never sent and cannot be reconstructed from what is.

`uncompromised:5` allows a password seen fewer than five times; the default is
zero, which is the only defensible threshold for a *new* password.

**A network failure passes.** Refusing to let somebody set a password because a
third-party API is down turns an outage there into an outage here, and the rule is
a safeguard rather than a gate.

## Files

`file`, `image`, `mimes`, `mimetypes`, `extensions`, `dimensions`, `size`,
`between`, `max`.

`image` reads the file's own header rather than trusting its extension or the
client's `content-type` — both are claims. See [images](/digging-deeper/images).

## Every rule

`accepted` `accepted_if` `active_url` `after` `after_or_equal` `alpha`
`alpha_dash` `alpha_num` `array` `array_keys` `ascii` `before` `before_or_equal`
`between` `boolean` `confirmed` `contains` `date` `date_equals` `date_format`
`decimal` `declined` `declined_if` `different` `digits` `digits_between`
`dimensions` `distinct` `doesnt_contain` `doesnt_end_with` `doesnt_start_with`
`email` `encoding` `ends_with` `exists` `extensions` `file` `filled` `gt` `gte`
`hex_color` `image` `in` `in_array` `in_array_keys` `integer` `ip` `json` `list`
`lowercase` `lt` `lte` `mac_address` `max` `max_digits` `mimes` `mimetypes` `min`
`min_digits` `missing` `missing_if` `missing_unless` `missing_with`
`missing_with_all` `multiple_of` `not_in` `not_regex` `numeric` `present`
`prohibited` `prohibited_if` `prohibited_if_accepted` `prohibited_if_declined`
`prohibited_unless` `prohibits` `regex` `required` `required_array_keys`
`required_if` `required_if_accepted` `required_if_declined` `required_unless`
`required_with` `required_with_all` `required_without` `required_without_all`
`same` `size` `starts_with` `string` `timezone` `ulid` `uncompromised` `unique`
`uppercase` `url` `uuid`

## Your own

```bash
bun elvel make:rule Slug
```

`after(callback)` on a validator runs once every rule has, which is where a check
spanning several fields belongs.
