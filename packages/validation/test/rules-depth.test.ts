import { describe, expect, test } from 'bun:test'
import { Validator } from '../src/validator.ts'

/** True when the field passed. */
async function passes(value: unknown, rule: string, rest: Record<string, unknown> = {}) {
  const validator = new Validator({ field: value, ...rest }, { field: rule } as never)

  return await validator.passes()
}

/** The rendered message, so the placeholders are exercised too. */
async function message(value: unknown, rule: string, rest: Record<string, unknown> = {}) {
  const validator = new Validator({ field: value, ...rest }, { field: rule } as never)
  await validator.passes()

  return validator.errors.first('field')
}

describe('shape of a string', () => {
  test('ascii is single-byte only', async () => {
    expect(await passes('plain-7bit ~', 'ascii')).toBe(true)
    // The rule exists to catch exactly this: it looks like a normal name.
    expect(await passes('naïve', 'ascii')).toBe(false)
    expect(await passes(7, 'ascii')).toBe(false)
  })

  test('hex_color takes three, four, six and eight digits', async () => {
    expect(await passes('#abc', 'hex_color')).toBe(true)
    expect(await passes('#AABBCC', 'hex_color')).toBe(true)
    // Four and eight carry alpha, and Laravel accepts both.
    expect(await passes('#abcd', 'hex_color')).toBe(true)
    expect(await passes('#aabbccdd', 'hex_color')).toBe(true)

    expect(await passes('abc', 'hex_color')).toBe(false)
    expect(await passes('#abcde', 'hex_color')).toBe(false)
    expect(await passes('#ghi', 'hex_color')).toBe(false)
  })

  test('ulid', async () => {
    expect(await passes('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ulid')).toBe(true)
    expect(await passes('not-a-ulid', 'ulid')).toBe(false)
  })

  test('ipv4 refuses what ip accepts', async () => {
    expect(await passes('192.168.0.1', 'ipv4')).toBe(true)
    // An address `ip` passes and this must not: that is the whole distinction.
    expect(await passes('::1', 'ipv4')).toBe(false)
    expect(await passes('::1', 'ip')).toBe(true)

    expect(await passes('999.0.0.1', 'ipv4')).toBe(false)
    // Leading zeros are a different address in some resolvers and a parse error
    // in others, so they are refused rather than guessed at.
    expect(await passes('192.168.00.1', 'ipv4')).toBe(false)
  })

  /**
   * Three spellings, because a MAC address is copied from wherever it appears.
   *
   * `0011.2233.4455` is Cisco's, and equipment prints it that way — a rule that
   * only knew colons would reject an address pasted off a switch.
   */
  test('mac_address', async () => {
    expect(await passes('00:11:22:33:44:55', 'mac_address')).toBe(true)
    expect(await passes('00-11-22-33-44-55', 'mac_address')).toBe(true)
    expect(await passes('0011.2233.4455', 'mac_address')).toBe(true)

    // Separators must not be mixed, which a looser regex would allow.
    expect(await passes('00:11-22:33-44:55', 'mac_address')).toBe(false)
    expect(await passes('00:11:22:33:44', 'mac_address')).toBe(false)
  })

  test('timezone reads the runtime rather than a shipped list', async () => {
    expect(await passes('Asia/Makassar', 'timezone')).toBe(true)
    expect(await passes('UTC', 'timezone')).toBe(true)
    expect(await passes('Mars/Olympus_Mons', 'timezone')).toBe(false)
  })

  /**
   * The group parameter is refused rather than ignored.
   *
   * `timezone:AFRICA` means "an African zone" in Laravel. `Intl` exposes no
   * grouping, so accepting the parameter and checking only membership would pass
   * `Asia/Tokyo` for a rule that excluded it — worse than saying so.
   */
  test('and says so rather than pretending to narrow', async () => {
    await expect(passes('Asia/Tokyo', 'timezone:AFRICA')).rejects.toThrow(/only supports the ALL/)
  })

  test('encoding checks the bytes decode', async () => {
    expect(await passes('plain', 'encoding:utf-8')).toBe(true)
    // Valid UTF-8 that is not valid as ASCII: the é is two bytes.
    expect(await passes('café', 'encoding:ascii')).toBe(false)
    expect(await passes(new Uint8Array([0xff, 0xfe]), 'encoding:utf-8')).toBe(false)
  })

  test('an unknown encoding is an error, not a failure', async () => {
    // A typo in the rule is a bug in the application; reporting it as "the user's
    // input was wrong" hides it behind a form.
    await expect(passes('x', 'encoding:utf-99')).rejects.toThrow(/not a valid encoding/)
  })
})

describe('active_url', () => {
  /**
   * `localhost`, so the test does not need a network.
   *
   * `dns.lookup` reads the hosts file before it asks a resolver, which is the
   * difference between this and `dns.resolve` — and the reason the rule uses it.
   */
  test('a host that resolves passes', async () => {
    expect(await passes('http://localhost/path', 'active_url')).toBe(true)
  })

  test('a string that is not a URL fails without asking anybody', async () => {
    expect(await passes('not a url', 'active_url')).toBe(false)
    expect(await passes('/relative/path', 'active_url')).toBe(false)
    expect(await passes(42, 'active_url')).toBe(false)
  })

  /**
   * It fails closed, and that is a decision rather than an accident.
   *
   * A resolver that cannot be reached is indistinguishable from a host that does
   * not exist, and passing on "we could not check" turns the rule into decoration
   * exactly when the network is having a bad day.
   */
  test('a host nobody answers for fails', async () => {
    // `.invalid` is reserved by RFC 2606 precisely so it can never resolve.
    expect(await passes('https://nothing.invalid', 'active_url')).toBe(false)
  })
})

describe('digit counts', () => {
  test('max_digits and min_digits count digits, not magnitude', async () => {
    expect(await passes('12345', 'max_digits:5')).toBe(true)
    expect(await passes(123_456, 'max_digits:5')).toBe(false)
    expect(await passes('12345', 'min_digits:5')).toBe(true)
    expect(await passes('1234', 'min_digits:5')).toBe(false)
  })

  test('and refuse anything that is not all digits', async () => {
    // `max:5` would happily take these; the point of the rule is that it does not.
    expect(await passes('12.34', 'max_digits:5')).toBe(false)
    expect(await passes('-1234', 'max_digits:5')).toBe(false)
    expect(await passes(['1', '2'], 'max_digits:5')).toBe(false)
  })

  /**
   * The reason this is not `value % divisor`.
   *
   * `0.3 % 0.1` is 0.09999999999999998 in binary floating point, so the obvious
   * spelling reports that 0.3 is not a multiple of 0.1 — wrong, and wrong in a
   * way that only shows up on the money fields where it matters.
   */
  test('multiple_of survives decimals', async () => {
    expect(await passes(0.3, 'multiple_of:0.1')).toBe(true)
    expect(await passes(9, 'multiple_of:3')).toBe(true)
    expect(await passes(10, 'multiple_of:3')).toBe(false)
    expect(await passes('7.50', 'multiple_of:0.25')).toBe(true)
  })

  test('and refuses a zero divisor rather than dividing by it', async () => {
    expect(await passes(0, 'multiple_of:0')).toBe(false)
    expect(await passes(5, 'multiple_of:0')).toBe(false)
    expect(await passes('abc', 'multiple_of:2')).toBe(false)
  })
})

describe('on arrays', () => {
  /**
   * `doesnt_contain` is about arrays; the `_with` pair is about strings.
   *
   * The names read alike and the types do not overlap, so a rule applied to the
   * wrong one fails every time rather than sometimes.
   */
  test('doesnt_contain works on the array, not the string', async () => {
    expect(await passes(['a', 'b'], 'doesnt_contain:c')).toBe(true)
    expect(await passes(['a', 'b'], 'doesnt_contain:b')).toBe(false)
    expect(await passes('abc', 'doesnt_contain:z')).toBe(false)
  })

  test('doesnt_start_with and doesnt_end_with work on the string', async () => {
    expect(await passes('hello', 'doesnt_start_with:x,y')).toBe(true)
    expect(await passes('hello', 'doesnt_start_with:x,he')).toBe(false)
    expect(await passes('hello', 'doesnt_end_with:x,lo')).toBe(false)
    // Numbers are stringified, as Laravel does.
    expect(await passes(2026, 'doesnt_start_with:19')).toBe(true)
  })

  test('array_keys refuses an unlisted key', async () => {
    expect(await passes({ a: 1, b: 2 }, 'array_keys:a,b,c')).toBe(true)
    expect(await passes({ a: 1, z: 2 }, 'array_keys:a,b')).toBe(false)
    // An empty object has no key outside the list, so it passes — `required`
    // is the rule that asks for content.
    expect(await passes({}, 'array_keys:a')).toBe(true)
  })

  test('in_array_keys asks for at least one', async () => {
    expect(await passes({ b: 1 }, 'in_array_keys:a,b')).toBe(true)
    expect(await passes({ z: 1 }, 'in_array_keys:a,b')).toBe(false)
    expect(await passes({}, 'in_array_keys:a')).toBe(false)
    expect(await passes(['a'], 'in_array_keys:a')).toBe(false)
  })
})

describe('prohibited when another field was answered', () => {
  test('prohibited_if_accepted', async () => {
    expect(await passes('x', 'prohibited_if_accepted:opt', { opt: 'yes' })).toBe(false)
    expect(await passes('x', 'prohibited_if_accepted:opt', { opt: 'no' })).toBe(true)
    // Empty is not "filled", so the prohibition is satisfied.
    expect(await passes('', 'prohibited_if_accepted:opt', { opt: 'on' })).toBe(true)
  })

  test('prohibited_if_declined', async () => {
    expect(await passes('x', 'prohibited_if_declined:opt', { opt: '0' })).toBe(false)
    expect(await passes('x', 'prohibited_if_declined:opt', { opt: '1' })).toBe(true)
  })

  /**
   * The reason these had to be listed as implicit.
   *
   * A rule that only runs when the key is present cannot prohibit anything: the
   * failing case is the key being there, and the passing case is it being absent.
   */
  test('and run when the field was not sent at all', async () => {
    const validator = new Validator({ opt: 'yes' }, {
      field: 'prohibited_if_accepted:opt'
    } as never)

    expect(await validator.passes()).toBe(true)
  })
})

describe('the messages', () => {
  test('name the values and the other field', async () => {
    expect(await message({ z: 1 }, 'array_keys:a,b')).toBe(
      'The field field must only contain the following keys: a, b.'
    )
    expect(await message('x', 'prohibited_if_accepted:opt', { opt: 'yes' })).toBe(
      'The field field is prohibited when opt is accepted.'
    )
    expect(await message('café', 'encoding:ascii')).toBe(
      'The field field must be encoded in ascii.'
    )
    expect(await message(10, 'multiple_of:3')).toBe('The field field must be a multiple of 3.')
    expect(await message(123_456, 'max_digits:5')).toBe(
      'The field field must not have more than 5 digits.'
    )
  })
})
