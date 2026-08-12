import { describe, expect, test } from 'bun:test'
import { Rule } from '../src/types.ts'
import { ValidationError, Validator } from '../src/validator.ts'

async function errors(data: Record<string, unknown>, rules: Record<string, unknown>) {
  const validator = new Validator(data, rules as never)
  await validator.passes()

  return validator.errors.messages()
}

describe('rule parsing', () => {
  test('pipe strings, arrays and rule objects', () => {
    expect(Validator.parse('required|min:3')).toEqual([
      { name: 'required', params: [] },
      { name: 'min', params: ['3'] }
    ])

    expect(Validator.parse(['required', 'between:1,5'])).toEqual([
      { name: 'required', params: [] },
      { name: 'between', params: ['1', '5'] }
    ])

    const parsed = Validator.parse(Rule.unique('users', 'email'))
    expect(parsed[0]?.name).toBe('unique')
    expect(parsed[0]?.rule).toBeDefined()
  })

  test('empty segments are dropped', () => {
    expect(Validator.parse('required||min:3')).toHaveLength(2)
  })
})

describe('presence', () => {
  test('required rejects empty values but accepts falsy ones', async () => {
    expect(await errors({}, { name: 'required' })).toHaveProperty('name')
    expect(await errors({ name: '' }, { name: 'required' })).toHaveProperty('name')
    expect(await errors({ name: '   ' }, { name: 'required' })).toHaveProperty('name')
    expect(await errors({ name: [] }, { name: 'required' })).toHaveProperty('name')
    expect(await errors({ name: null }, { name: 'required' })).toHaveProperty('name')

    // 0 and false are values, not absences.
    expect(await errors({ name: 0 }, { name: 'required' })).toEqual({})
    expect(await errors({ name: false }, { name: 'required' })).toEqual({})
  })

  test('an absent optional field skips its other rules', async () => {
    expect(await errors({}, { email: 'email|min:5' })).toEqual({})
  })

  test('a whitespace-only string only runs implicit rules', async () => {
    // `required` fails; `email` does not also fire, which keeps the bag readable.
    expect(await errors({ email: '  ' }, { email: 'required|email' })).toEqual({
      email: ['The email field is required.']
    })
  })

  test('nullable allows an explicit null through the type rules', async () => {
    expect(await errors({ age: null }, { age: 'nullable|integer' })).toEqual({})
    expect(await errors({ age: 'x' }, { age: 'nullable|integer' })).toHaveProperty('age')
  })

  test('sometimes skips an absent key entirely', async () => {
    expect(await errors({}, { age: 'sometimes|required|integer' })).toEqual({})
    expect(await errors({ age: '' }, { age: 'sometimes|required|integer' })).toHaveProperty('age')
  })

  test('present demands the key but not a value', async () => {
    expect(await errors({}, { note: 'present' })).toHaveProperty('note')
    expect(await errors({ note: '' }, { note: 'present' })).toEqual({})
  })

  test('filled demands a value only when the key is sent', async () => {
    expect(await errors({}, { note: 'filled' })).toEqual({})
    expect(await errors({ note: '' }, { note: 'filled' })).toHaveProperty('note')
  })

  test('missing and prohibited', async () => {
    expect(await errors({ trap: 'x' }, { trap: 'missing' })).toHaveProperty('trap')
    expect(await errors({}, { trap: 'missing' })).toEqual({})
    expect(await errors({ trap: 'x' }, { trap: 'prohibited' })).toHaveProperty('trap')
  })
})

describe('stopping', () => {
  test('an implicit failure stops the remaining rules for that attribute', async () => {
    const bag = await errors({}, { email: 'required|email|min:10' })

    expect(bag.email).toEqual(['The email field is required.'])
  })

  test('without bail, several rules can fail on one attribute', async () => {
    const bag = await errors({ code: 'ab' }, { code: 'min:5|alpha_num|starts_with:zz' })

    expect(bag.code?.length).toBe(2)
  })

  test('bail stops after the first failure', async () => {
    const bag = await errors({ code: 'ab' }, { code: 'bail|min:5|starts_with:zz' })

    expect(bag.code).toHaveLength(1)
  })

  test('stopOnFirstFailure stops the whole validator', async () => {
    const validator = new Validator(
      { a: '', b: '' },
      { a: 'required', b: 'required' },
      { stopOnFirstFailure: true }
    )

    await validator.passes()

    expect(validator.errors.keys()).toEqual(['a'])
  })
})

describe('types and formats', () => {
  test('numeric, integer and boolean accept string forms', async () => {
    expect(await errors({ n: '12' }, { n: 'numeric' })).toEqual({})
    expect(await errors({ n: '12.5' }, { n: 'numeric' })).toEqual({})
    expect(await errors({ n: '12.5' }, { n: 'integer' })).toHaveProperty('n')
    expect(await errors({ n: '1' }, { n: 'boolean' })).toEqual({})
    expect(await errors({ n: 'yes' }, { n: 'boolean' })).toEqual({})
    expect(await errors({ n: 'maybe' }, { n: 'boolean' })).toHaveProperty('n')
  })

  test('email, url, uuid, ip and json', async () => {
    expect(await errors({ v: 'a@b.co' }, { v: 'email' })).toEqual({})
    expect(await errors({ v: 'a@b' }, { v: 'email' })).toHaveProperty('v')
    expect(await errors({ v: 'https://x.dev' }, { v: 'url' })).toEqual({})
    expect(await errors({ v: crypto.randomUUID() }, { v: 'uuid' })).toEqual({})
    expect(await errors({ v: '10.0.0.1' }, { v: 'ip' })).toEqual({})
    expect(await errors({ v: '999.0.0.1' }, { v: 'ip' })).toHaveProperty('v')
    expect(await errors({ v: '{"a":1}' }, { v: 'json' })).toEqual({})
    expect(await errors({ v: '{' }, { v: 'json' })).toHaveProperty('v')
  })

  test('alpha family and case', async () => {
    expect(await errors({ v: 'abc' }, { v: 'alpha' })).toEqual({})
    expect(await errors({ v: 'a-b_1' }, { v: 'alpha_dash' })).toEqual({})
    expect(await errors({ v: 'a b' }, { v: 'alpha_num' })).toHaveProperty('v')
    expect(await errors({ v: 'abc' }, { v: 'lowercase' })).toEqual({})
    expect(await errors({ v: 'Abc' }, { v: 'uppercase' })).toHaveProperty('v')
  })

  test('regex, digits and decimal', async () => {
    expect(await errors({ v: 'ab' }, { v: 'regex:/^[a-z]+$/' })).toEqual({})
    expect(await errors({ v: 'a1' }, { v: 'regex:/^[a-z]+$/' })).toHaveProperty('v')
    expect(await errors({ v: 'a1' }, { v: 'not_regex:/^[a-z]+$/' })).toEqual({})
    expect(await errors({ v: '1234' }, { v: 'digits:4' })).toEqual({})
    expect(await errors({ v: '123' }, { v: 'digits_between:4,6' })).toHaveProperty('v')
    expect(await errors({ v: '1.25' }, { v: 'decimal:2' })).toEqual({})
    expect(await errors({ v: '1.2' }, { v: 'decimal:2' })).toHaveProperty('v')
  })
})

describe('size rules', () => {
  test('measure length for strings, items for arrays, magnitude for numbers', async () => {
    expect(await errors({ v: 'abc' }, { v: 'min:3' })).toEqual({})
    expect(await errors({ v: 'ab' }, { v: 'min:3' })).toHaveProperty('v')
    expect(await errors({ v: [1, 2] }, { v: 'min:3' })).toHaveProperty('v')
    expect(await errors({ v: 5 }, { v: 'min:3' })).toEqual({})
    // A numeric rule alongside makes a numeric string compare as a number.
    expect(await errors({ v: '5' }, { v: 'numeric|min:3' })).toEqual({})
    expect(await errors({ v: '5' }, { v: 'min:3' })).toHaveProperty('v')
  })

  test('the message names the right unit', async () => {
    expect((await errors({ v: 'ab' }, { v: 'min:3' })).v?.[0]).toContain('3 characters')
    expect((await errors({ v: [1] }, { v: 'min:3' })).v?.[0]).toContain('3 items')
    expect((await errors({ v: 1 }, { v: 'numeric|min:3' })).v?.[0]).toBe(
      'The v field must be at least 3.'
    )
  })

  test('between, size, gt and lte compare against another field', async () => {
    expect(await errors({ v: 'abc' }, { v: 'between:1,5' })).toEqual({})
    expect(await errors({ v: 'abc' }, { v: 'size:3' })).toEqual({})
    expect(await errors({ a: 5, b: 3 }, { a: 'numeric|gt:b' })).toEqual({})
    expect(await errors({ a: 2, b: 3 }, { a: 'numeric|gt:b' })).toHaveProperty('a')
    expect(await errors({ a: 3, b: 3 }, { a: 'numeric|lte:b' })).toEqual({})
  })
})

describe('cross-field rules', () => {
  test('confirmed looks for the _confirmation twin', async () => {
    expect(
      await errors(
        { password: 'secret', password_confirmation: 'secret' },
        { password: 'confirmed' }
      )
    ).toEqual({})

    expect(
      await errors({ password: 'secret', password_confirmation: 'typo' }, { password: 'confirmed' })
    ).toEqual({ password: ['The password field confirmation does not match.'] })
  })

  test('same and different', async () => {
    expect(await errors({ a: 'x', b: 'x' }, { a: 'same:b' })).toEqual({})
    expect(await errors({ a: 'x', b: 'y' }, { a: 'same:b' })).toHaveProperty('a')
    expect(await errors({ a: 'x', b: 'y' }, { a: 'different:b' })).toEqual({})
  })

  test('required_if and required_unless', async () => {
    expect(await errors({ kind: 'card' }, { number: 'required_if:kind,card' })).toHaveProperty(
      'number'
    )
    expect(await errors({ kind: 'cash' }, { number: 'required_if:kind,card' })).toEqual({})
    // The named field being absent means the condition cannot hold.
    expect(await errors({}, { number: 'required_if:kind,card' })).toEqual({})

    expect(await errors({ kind: 'cash' }, { number: 'required_unless:kind,card' })).toHaveProperty(
      'number'
    )
    expect(await errors({ kind: 'card' }, { number: 'required_unless:kind,card' })).toEqual({})
  })

  test('required_with, required_with_all, required_without, required_without_all', async () => {
    expect(await errors({ a: 1 }, { b: 'required_with:a' })).toHaveProperty('b')
    expect(await errors({}, { b: 'required_with:a' })).toEqual({})
    expect(await errors({ a: 1 }, { c: 'required_with_all:a,b' })).toEqual({})
    expect(await errors({ a: 1, b: 2 }, { c: 'required_with_all:a,b' })).toHaveProperty('c')
    expect(await errors({}, { b: 'required_without:a' })).toHaveProperty('b')
    expect(await errors({ a: 1 }, { b: 'required_without:a' })).toEqual({})
    expect(await errors({}, { c: 'required_without_all:a,b' })).toHaveProperty('c')
    expect(await errors({ a: 1 }, { c: 'required_without_all:a,b' })).toEqual({})
  })

  test('accepted, declined and their conditional forms', async () => {
    expect(await errors({ tos: 'yes' }, { tos: 'accepted' })).toEqual({})
    expect(await errors({ tos: 'no' }, { tos: 'accepted' })).toHaveProperty('tos')
    expect(await errors({ tos: 'off' }, { tos: 'declined' })).toEqual({})
    expect(await errors({ kind: 'a', tos: 'no' }, { tos: 'accepted_if:kind,a' })).toHaveProperty(
      'tos'
    )
    expect(await errors({ kind: 'b', tos: 'no' }, { tos: 'accepted_if:kind,a' })).toEqual({})
  })

  test('prohibited_if and prohibits', async () => {
    expect(
      await errors({ kind: 'a', extra: 'x' }, { extra: 'prohibited_if:kind,a' })
    ).toHaveProperty('extra')
    expect(await errors({ a: 'x', b: 'y' }, { a: 'prohibits:b' })).toHaveProperty('a')
    expect(await errors({ a: 'x' }, { a: 'prohibits:b' })).toEqual({})
  })

  test('in, not_in and in_array', async () => {
    expect(await errors({ v: 'a' }, { v: 'in:a,b' })).toEqual({})
    expect(await errors({ v: 'c' }, { v: 'in:a,b' })).toHaveProperty('v')
    expect(await errors({ v: 'c' }, { v: 'not_in:a,b' })).toEqual({})
    expect(await errors({ v: 'a', list: ['a'] }, { v: 'in_array:list' })).toEqual({})
    expect(await errors({ v: 'z', list: ['a'] }, { v: 'in_array:list' })).toHaveProperty('v')
  })

  test('date comparisons accept a literal or another field', async () => {
    expect(
      await errors({ end: '2026-02-01', start: '2026-01-01' }, { end: 'after:start' })
    ).toEqual({})
    expect(
      await errors({ end: '2025-01-01', start: '2026-01-01' }, { end: 'after:start' })
    ).toHaveProperty('end')
    expect(await errors({ v: '2026-01-02' }, { v: 'after:2026-01-01' })).toEqual({})
    expect(await errors({ v: '2026-01-01' }, { v: 'after_or_equal:2026-01-01' })).toEqual({})
    expect(await errors({ v: 'not a date' }, { v: 'date' })).toHaveProperty('v')
  })

  test('starts_with and ends_with take several options', async () => {
    expect(await errors({ v: 'abc' }, { v: 'starts_with:x,a' })).toEqual({})
    expect(await errors({ v: 'abc' }, { v: 'ends_with:z' })).toHaveProperty('v')
  })
})

describe('exclude rules', () => {
  test('exclude_if drops the attribute rather than failing it', async () => {
    const validator = new Validator(
      { kind: 'cash', number: 'nonsense' },
      { kind: 'required', number: 'exclude_if:kind,cash|min:10' }
    )

    expect(await validator.passes()).toBe(true)
    expect(validator.validated()).toEqual({ kind: 'cash' })
  })

  test('exclude_unless keeps it when the condition holds', async () => {
    const validator = new Validator(
      { kind: 'card', number: '4111111111111111' },
      { kind: 'required', number: 'exclude_unless:kind,card|min:10' }
    )

    expect(await validator.passes()).toBe(true)
    expect(validator.validated()).toHaveProperty('number')
  })

  test('exclude always drops', async () => {
    const validator = new Validator({ a: 1, b: 2 }, { a: 'exclude', b: 'required' })
    await validator.passes()

    expect(validator.validated()).toEqual({ b: 2 })
  })
})

describe('validated output', () => {
  test('only validated keys survive, so an unchecked field cannot reach a write', async () => {
    const validator = new Validator({ name: 'Ada', is_admin: true }, { name: 'required|string' })

    expect(await validator.passes()).toBe(true)
    expect(validator.validated()).toEqual({ name: 'Ada' })
  })

  test('validate() returns the data or throws with the bag', async () => {
    expect(await new Validator({ name: 'Ada' }, { name: 'required' }).validate()).toEqual({
      name: 'Ada'
    })

    const failing = new Validator({}, { name: 'required' })

    await expect(failing.validate()).rejects.toThrow(ValidationError)
    await expect(failing.validate()).rejects.toThrow('The name field is required.')
  })

  test('the error carries the full bag', async () => {
    try {
      await new Validator({}, { name: 'required', email: 'required' }).validate()
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).errors.messages()).toEqual({
        name: ['The name field is required.'],
        email: ['The email field is required.']
      })
    }
  })

  test('dot notation reads and writes nested data', async () => {
    const validator = new Validator(
      { user: { name: 'Ada', secret: 'x' } },
      { 'user.name': 'required|string' }
    )

    expect(await validator.passes()).toBe(true)
    expect(validator.validated()).toEqual({ user: { name: 'Ada' } })
  })
})

describe('messages', () => {
  test('attribute names are humanised', async () => {
    expect((await errors({}, { first_name: 'required' })).first_name?.[0]).toBe(
      'The first name field is required.'
    )
  })

  test('a custom message replaces the default, per rule or per field', async () => {
    const byRule = new Validator({}, { name: 'required' }, { messages: { required: 'Need it.' } })
    await byRule.passes()
    expect(byRule.errors.first()).toBe('Need it.')

    const byField = new Validator(
      { a: '', b: '' },
      { a: 'required', b: 'required' },
      { messages: { 'a.required': 'A is special.' } }
    )
    await byField.passes()
    expect(byField.errors.first('a')).toBe('A is special.')
    expect(byField.errors.first('b')).toBe('The b field is required.')
  })

  test('a custom attribute label is used in every message', async () => {
    const validator = new Validator(
      {},
      { email_address: 'required' },
      { attributes: { email_address: 'e-mail' } }
    )
    await validator.passes()

    expect(validator.errors.first()).toBe('The e-mail field is required.')
  })

  test(':other names the referenced field', async () => {
    const bag = await errors({ kind: 'card' }, { card_number: 'required_if:kind,card' })

    expect(bag.card_number?.[0]).toBe('The card number field is required when kind is card.')
  })

  test('an unknown rule fails loudly instead of passing silently', async () => {
    await expect(new Validator({ a: 1 }, { a: 'nope' }).passes()).rejects.toThrow(
      /rule \[nope\] does not exist/
    )
  })
})

describe('after hooks', () => {
  test('run once the rules have finished, and can add errors', async () => {
    const validator = new Validator({ password: 'secret' }, { password: 'required' }).after(
      (instance) => {
        instance.addError('password', 'That password is too common.')
      }
    )

    expect(await validator.passes()).toBe(false)
    expect(validator.errors.first('password')).toBe('That password is too common.')
  })

  test('an after hook sees the errors the rules produced', async () => {
    let seen = 0

    const validator = new Validator({}, { name: 'required' }).after((instance) => {
      seen = instance.errors.count()
    })

    await validator.passes()

    expect(seen).toBe(1)
  })
})

describe('error bag', () => {
  test('exposes first, get, all, keys and the JSON shape', async () => {
    const validator = new Validator(
      { a: 'x' },
      { a: 'min:5|alpha_num|starts_with:zz', b: 'required' }
    )
    await validator.passes()

    expect(validator.errors.first('a')).toContain('at least 5')
    expect(validator.errors.get('a')).toHaveLength(2)
    expect(validator.errors.keys().sort()).toEqual(['a', 'b'])
    expect(validator.errors.count()).toBe(3)
    expect(JSON.parse(JSON.stringify(validator.errors))).toHaveProperty('b')
  })

  test('duplicate messages are not repeated', async () => {
    const validator = new Validator(
      { a: '' },
      { a: 'required' },
      { messages: { required: 'Nope.' } }
    )
    await validator.passes()
    validator.addError('a', 'Nope.')

    expect(validator.errors.get('a')).toEqual(['Nope.'])
  })
})

describe('idempotence', () => {
  test('passes() twice does not double the errors', async () => {
    const validator = new Validator({}, { name: 'required' })

    await validator.passes()
    await validator.passes()

    expect(validator.errors.get('name')).toHaveLength(1)
  })
})

describe('size messages', () => {
  test('every size rule renders its own number', async () => {
    const cases: Array<[string, string]> = [
      ['max:5', 'The title field must not be greater than 5 characters.'],
      ['min:20', 'The title field must be at least 20 characters.'],
      ['between:1,3', 'The title field must be between 1 and 3 characters.'],
      ['size:4', 'The title field must be 4 characters.']
    ]

    for (const [rule, expected] of cases) {
      const validator = new Validator({ title: 'far too long' }, { title: rule })
      await validator.passes()

      expect(validator.errors.first()).toBe(expected)
    }
  })
})

describe('wildcards', () => {
  test('a rule per element, named by its own path', async () => {
    const messages = await errors(
      { items: [{ price: 10 }, { price: -1 }, { price: 'free' }] },
      { 'items.*.price': 'required|numeric|min:0' }
    )

    expect(Object.keys(messages)).toEqual(['items.1.price', 'items.2.price'])
    expect(messages['items.1.price']?.[0]).toContain('at least 0')
  })

  test('an element that left the field out still fails required', async () => {
    // The reason expansion walks the pattern instead of filtering the data: an
    // attribute that does not exist cannot fail, and "you forgot the price on the
    // second line" is exactly what has to be reported.
    const messages = await errors({ items: [{ price: 1 }, {}] }, { 'items.*.price': 'required' })

    expect(Object.keys(messages)).toEqual(['items.1.price'])
  })

  test('a missing collection reports itself, not its elements', async () => {
    const messages = await errors({}, { items: 'required|array', 'items.*.price': 'required' })

    // One error, on `items`. Reporting `items.0.price` as well would invent an
    // element nobody sent.
    expect(Object.keys(messages)).toEqual(['items'])
  })

  test('a collection of the wrong type reports itself once', async () => {
    const messages = await errors(
      { items: 'not a list' },
      { items: 'array', 'items.*.price': 'required' }
    )

    expect(Object.keys(messages)).toEqual(['items'])
  })

  test('object keys work as well as array indices', async () => {
    const messages = await errors(
      { rates: { usd: 1.1, gbp: 'no' } },
      { 'rates.*': 'required|numeric' }
    )

    expect(Object.keys(messages)).toEqual(['rates.gbp'])
  })

  test('wildcards nest', async () => {
    const messages = await errors(
      { orders: [{ lines: [{ qty: 1 }, { qty: 0 }] }, { lines: [{ qty: 'x' }] }] },
      { 'orders.*.lines.*.qty': 'required|numeric|min:1' }
    )

    expect(Object.keys(messages)).toEqual(['orders.0.lines.1.qty', 'orders.1.lines.0.qty'])
  })

  test('a trailing wildcard covers the elements themselves', async () => {
    const messages = await errors({ tags: ['ok', ''] }, { 'tags.*': 'required|string' })

    expect(Object.keys(messages)).toEqual(['tags.1'])
  })

  test('validated() keeps the nested shape', async () => {
    const validator = new Validator(
      { items: [{ price: 1 }, { price: 2 }], junk: 'dropped' },
      { 'items.*.price': 'required|numeric' }
    )

    expect(await validator.validate()).toEqual({ items: [{ price: 1 }, { price: 2 }] })
  })

  test('a message written for the pattern is found from the element', async () => {
    const validator = new Validator(
      { items: [{ price: -1 }] },
      { 'items.*.price': 'min:0' },
      { messages: { 'items.*.price.min': 'Line :position cannot be negative.' } }
    )

    await validator.passes()

    // `:position` counts from one: "line 1" is what the person reading it sees.
    expect(validator.errors.first()).toBe('Line 1 cannot be negative.')
  })

  test(':index is the key as it stands in the data', async () => {
    const validator = new Validator(
      { items: [{ price: -1 }, { price: -2 }] },
      { 'items.*.price': 'min:0' },
      { messages: { 'items.*.price.min': 'index :index, position :position' } }
    )

    await validator.passes()

    expect(validator.errors.get('items.1.price')[0]).toBe('index 1, position 2')
  })

  test('an attribute label written for the pattern is used', async () => {
    const validator = new Validator(
      { items: [{ price: -1 }] },
      { 'items.*.price': 'min:0' },
      { attributes: { 'items.*.price': 'line price' } }
    )

    await validator.passes()

    expect(validator.errors.first()).toContain('line price')
  })
})

describe('array rules', () => {
  test('array with named keys refuses anything else', async () => {
    expect(await errors({ user: { name: 'Ada' } }, { user: 'array:name,email' })).toEqual({})

    // The point of naming keys: an extra one is a failure, not something quietly
    // carried through into validated().
    const messages = await errors(
      { user: { name: 'Ada', admin: true } },
      { user: 'array:name,email' }
    )
    expect(messages.user?.[0]).toContain('must be an array')
  })

  test('list wants sequential keys', async () => {
    expect(await errors({ tags: ['a', 'b'] }, { tags: 'list' })).toEqual({})
    expect(Object.keys(await errors({ tags: { 0: 'a' } }, { tags: 'list' }))).toEqual(['tags'])
  })

  test('required_array_keys names what is missing', async () => {
    expect(await errors({ opts: { a: 1, b: 2 } }, { opts: 'required_array_keys:a,b' })).toEqual({})

    const messages = await errors({ opts: { a: 1 } }, { opts: 'required_array_keys:a,b' })
    expect(messages.opts?.[0]).toContain('a, b')
  })

  test('contains wants every value present', async () => {
    expect(await errors({ roles: ['admin', 'editor'] }, { roles: 'contains:admin' })).toEqual({})
    expect(Object.keys(await errors({ roles: ['editor'] }, { roles: 'contains:admin' }))).toEqual([
      'roles'
    ])
  })
})

describe('distinct', () => {
  test('a repeated value fails, on both of them', async () => {
    const messages = await errors({ ids: [1, 2, 1] }, { 'ids.*': 'distinct' })

    // Both, because neither is "the duplicate" — the pair is.
    expect(Object.keys(messages)).toEqual(['ids.0', 'ids.2'])
  })

  test('no repeats, no errors', async () => {
    expect(await errors({ ids: [1, 2, 3] }, { 'ids.*': 'distinct' })).toEqual({})
  })

  test('loose by default, because a form sends numbers as text', async () => {
    expect(Object.keys(await errors({ ids: [1, '1'] }, { 'ids.*': 'distinct' }))).toHaveLength(2)
    expect(await errors({ ids: [1, '1'] }, { 'ids.*': 'distinct:strict' })).toEqual({})
  })

  test('ignore_case folds case', async () => {
    expect(await errors({ tags: ['A', 'a'] }, { 'tags.*': 'distinct' })).toEqual({})
    expect(
      Object.keys(await errors({ tags: ['A', 'a'] }, { 'tags.*': 'distinct:ignore_case' }))
    ).toHaveLength(2)
  })

  test('it compares within one collection, not across the payload', async () => {
    const messages = await errors(
      { first: [1, 2], second: [1, 2] },
      { 'first.*': 'distinct', 'second.*': 'distinct' }
    )

    expect(messages).toEqual({})
  })

  test('nested siblings are the ones under the same parent', async () => {
    const messages = await errors(
      { orders: [{ lines: [1, 1] }, { lines: [1, 2] }] },
      { 'orders.*.lines.*': 'distinct' }
    )

    // `orders.*.lines.*` covers every line of every order, so the two 1s in the
    // first order collide with the 1 in the second as well — the pattern is what
    // decides the scope, exactly as Laravel does.
    expect(Object.keys(messages)).toEqual([
      'orders.0.lines.0',
      'orders.0.lines.1',
      'orders.1.lines.0'
    ])
  })
})

describe('file rules', () => {
  /** A real PNG: signature, then an IHDR chunk carrying the dimensions. */
  function png(width: number, height: number, name = 'photo.png'): File {
    const bytes = new Uint8Array(24)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const header = new DataView(bytes.buffer)
    header.setUint32(8, 13)
    bytes.set([0x49, 0x48, 0x44, 0x52], 12)
    header.setUint32(16, width)
    header.setUint32(20, height)

    return new File([bytes], name, { type: 'image/png' })
  }

  function gif(width: number, height: number, name = 'anim.gif'): File {
    const bytes = new Uint8Array(16)
    bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    const header = new DataView(bytes.buffer)
    header.setUint16(6, width, true)
    header.setUint16(8, height, true)

    return new File([bytes], name, { type: 'image/gif' })
  }

  test('file wants an upload, not a field named like one', async () => {
    expect(await errors({ avatar: png(1, 1) }, { avatar: 'file' })).toEqual({})
    expect(Object.keys(await errors({ avatar: 'photo.png' }, { avatar: 'file' }))).toEqual([
      'avatar'
    ])
  })

  test('image reads the bytes, not the claimed type', async () => {
    expect(await errors({ avatar: png(4, 4) }, { avatar: 'image' })).toEqual({})

    // A text file renamed and re-labelled: every claim says image/png.
    const liar = new File([new TextEncoder().encode('<?php echo 1;')], 'photo.png', {
      type: 'image/png'
    })

    expect(Object.keys(await errors({ avatar: liar }, { avatar: 'image' }))).toEqual(['avatar'])
  })

  test('mimes accepts a matching extension family', async () => {
    expect(await errors({ avatar: png(1, 1) }, { avatar: 'mimes:png,jpg' })).toEqual({})
    expect(Object.keys(await errors({ avatar: gif(1, 1) }, { avatar: 'mimes:png,jpg' }))).toEqual([
      'avatar'
    ])
  })

  test('mimes names the types in its message', async () => {
    const messages = await errors({ avatar: gif(1, 1) }, { avatar: 'mimes:png,jpg' })

    expect(messages.avatar?.[0]).toContain('png, jpg')
  })

  test('an executable extension is refused unless asked for by name', async () => {
    const script = new File([new TextEncoder().encode('#!/bin/sh')], 'run.sh', {
      type: 'text/plain'
    })

    expect(Object.keys(await errors({ file: script }, { file: 'mimes:txt' }))).toEqual(['file'])
  })

  test('extensions checks the name, and says so by ignoring the content', async () => {
    // A PNG called `.jpg` passes `extensions:jpg` and fails `mimes:jpg` — the two
    // rules answer different questions on purpose.
    const misnamed = png(1, 1, 'photo.jpg')

    expect(await errors({ avatar: misnamed }, { avatar: 'extensions:jpg' })).toEqual({})
    expect(Object.keys(await errors({ avatar: misnamed }, { avatar: 'mimes:jpg' }))).toEqual([
      'avatar'
    ])
  })

  test('mimetypes takes a media type directly', async () => {
    expect(await errors({ avatar: png(1, 1) }, { avatar: 'mimetypes:image/png' })).toEqual({})
    expect(
      Object.keys(await errors({ avatar: png(1, 1) }, { avatar: 'mimetypes:application/pdf' }))
    ).toEqual(['avatar'])
  })

  test('size rules on a file are kilobytes', async () => {
    const file = new File([new Uint8Array(4096)], 'blob.bin')

    // 4KB: under a 8KB ceiling, over a 2KB one.
    expect(await errors({ upload: file }, { upload: 'max:8' })).toEqual({})

    const messages = await errors({ upload: file }, { upload: 'max:2' })
    expect(messages.upload?.[0]).toBe('The upload field must not be greater than 2 kilobytes.')
  })

  test('dimensions reads width and height out of the file', async () => {
    expect(
      await errors({ avatar: png(100, 50) }, { avatar: 'dimensions:width=100,height=50' })
    ).toEqual({})

    const messages = await errors({ avatar: png(100, 50) }, { avatar: 'dimensions:min_width=200' })
    expect(messages.avatar?.[0]).toContain('invalid image dimensions')
  })

  test('dimensions understands a ratio, with room for rounding', async () => {
    // 1600x900 is 16:9, and an exact float comparison would reject it.
    expect(await errors({ avatar: png(1600, 900) }, { avatar: 'dimensions:ratio=16/9' })).toEqual(
      {}
    )
    expect(
      Object.keys(await errors({ avatar: png(1600, 1000) }, { avatar: 'dimensions:ratio=16/9' }))
    ).toEqual(['avatar'])
  })

  test('a GIF is measured the same way', async () => {
    expect(await errors({ avatar: gif(320, 240) }, { avatar: 'dimensions:width=320' })).toEqual({})
  })

  test('a file rule on something that is not a file fails rather than throwing', async () => {
    for (const rule of [
      'image',
      'mimes:png',
      'mimetypes:image/png',
      'extensions:png',
      'dimensions:width=1'
    ]) {
      expect(Object.keys(await errors({ avatar: 'nope' }, { avatar: rule }))).toEqual(['avatar'])
    }
  })

  test('uploads work under a wildcard, like anything else', async () => {
    const messages = await errors(
      { photos: [png(10, 10), new File(['x'], 'notes.txt', { type: 'text/plain' })] },
      { 'photos.*': 'image' }
    )

    expect(Object.keys(messages)).toEqual(['photos.1'])
  })
})
