import { assert, contains, dataGet, dataHas, equals, fail, show } from './assert.ts'

/**
 * A fluent walk over a decoded JSON body — Laravel's `AssertableJson`.
 *
 * What makes it worth having over a pile of `assertJsonPath` calls is the
 * interaction check: every key touched is remembered, and leaving a scope
 * asserts that nothing was left untouched. A response that grows a field
 * therefore fails the test that claimed to describe it, which is the opposite of
 * how a containment assertion behaves — `assertJson` passes happily while the
 * payload doubles in size.
 *
 * `etc()` opts out of that for one scope, and is deliberately noisy to write.
 */
export class AssertableJson {
  private readonly interacted = new Set<string>()
  private allowsExtra = false

  constructor(
    private readonly value: unknown,
    private readonly path = ''
  ) {}

  /** Where we are, for a message that means something three levels deep. */
  private at(key: string): string {
    return this.path === '' ? key : `${this.path}.${key}`
  }

  private describe(): string {
    return this.path === '' ? 'the root' : `[${this.path}]`
  }

  /**
   * The property exists.
   *
   * With a number, the property is an array of that length. With a callback, the
   * callback is run against the property as its own scope — which is what makes
   * the interaction check recursive.
   */
  has(key: string, length?: number, callback?: (json: AssertableJson) => void): this {
    assert(
      dataHas(this.value, key),
      `Expected ${this.describe()} to have property [${key}], but it does not. Saw: ${show(this.value)}`
    )
    this.interacted.add(key.split('.')[0] as string)

    const found = dataGet(this.value, key)

    if (typeof length === 'number') {
      assert(
        Array.isArray(found) && found.length === length,
        `Expected [${this.at(key)}] to be an array of ${length}, saw ${show(found)}`,
        length,
        Array.isArray(found) ? found.length : undefined
      )
    }

    if (callback) new AssertableJson(found, this.at(key)).verify(callback)

    return this
  }

  hasAll(...keys: string[]): this {
    for (const key of keys.flat()) this.has(key)

    return this
  }

  /** At least one of them — for a payload whose shape depends on a branch. */
  hasAny(...keys: string[]): this {
    const flat = keys.flat()
    const found = flat.filter((key) => dataHas(this.value, key))

    assert(
      found.length > 0,
      `Expected ${this.describe()} to have at least one of [${flat.join(', ')}], saw none. Saw: ${show(this.value)}`
    )
    for (const key of found) this.interacted.add(key.split('.')[0] as string)

    return this
  }

  missing(key: string): this {
    assert(
      !dataHas(this.value, key),
      `Expected ${this.describe()} not to have property [${key}], but it does: ${show(dataGet(this.value, key))}`
    )

    return this
  }

  missingAll(...keys: string[]): this {
    for (const key of keys.flat()) this.missing(key)

    return this
  }

  /** Exists and equals — structurally, so key order does not matter. */
  where(key: string, expected: unknown): this {
    this.has(key)
    const found = dataGet(this.value, key)

    assert(
      equals(found, expected),
      `Expected [${this.at(key)}] to be ${show(expected)}, saw ${show(found)}`,
      expected,
      found
    )

    return this
  }

  whereNot(key: string, expected: unknown): this {
    this.has(key)
    const found = dataGet(this.value, key)

    assert(
      !equals(found, expected),
      `Expected [${this.at(key)}] not to be ${show(expected)}, but it is`
    )

    return this
  }

  whereAll(values: Record<string, unknown>): this {
    for (const [key, expected] of Object.entries(values)) this.where(key, expected)

    return this
  }

  /** Exists and contains — the subset rule, for a nested object or array. */
  whereContains(key: string, expected: unknown): this {
    this.has(key)
    const found = dataGet(this.value, key)

    assert(
      contains(found, expected),
      `Expected [${this.at(key)}] to contain ${show(expected)}, saw ${show(found)}`,
      expected,
      found
    )

    return this
  }

  whereType(
    key: string,
    type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'
  ): this {
    this.has(key)
    const found = dataGet(this.value, key)
    const actual = found === null ? 'null' : Array.isArray(found) ? 'array' : typeof found

    assert(
      actual === type,
      `Expected [${this.at(key)}] to be a ${type}, saw ${actual}`,
      type,
      actual
    )

    return this
  }

  /** The scope itself is an array of this length. */
  count(length: number): this {
    assert(
      Array.isArray(this.value) && this.value.length === length,
      `Expected ${this.describe()} to be an array of ${length}, saw ${show(this.value)}`,
      length,
      Array.isArray(this.value) ? this.value.length : undefined
    )

    return this
  }

  /** Run the callback against every element, each as its own scope. */
  each(callback: (json: AssertableJson, index: number) => void): this {
    if (!Array.isArray(this.value)) {
      fail(`Expected ${this.describe()} to be an array, saw ${show(this.value)}`)
    }

    this.value.forEach((item, index) => {
      new AssertableJson(item, this.at(String(index))).verify((json) => callback(json, index))
    })

    return this
  }

  /** The first element, as its own scope. */
  first(callback: (json: AssertableJson) => void): this {
    if (!Array.isArray(this.value) || this.value.length === 0) {
      fail(`Expected ${this.describe()} to be a non-empty array, saw ${show(this.value)}`)
    }

    new AssertableJson(this.value[0], this.at('0')).verify(callback)

    return this
  }

  /** Whatever else is in this scope, do not complain about it. */
  etc(): this {
    this.allowsExtra = true

    return this
  }

  /** The scope's raw value, for an assertion this class does not cover. */
  json(): unknown {
    return this.value
  }

  /**
   * Run a callback as a scope, then hold it to what it touched.
   *
   * Called by `has(key, …, callback)`, `each` and `first`, and by
   * `TestResponse.assertJsonFluent` for the root.
   */
  verify(callback: (json: AssertableJson) => void): this {
    callback(this)

    if (this.allowsExtra) return this
    if (this.value === null || typeof this.value !== 'object' || Array.isArray(this.value))
      return this

    const untouched = Object.keys(this.value as Record<string, unknown>).filter(
      (key) => !this.interacted.has(key)
    )

    assert(
      untouched.length === 0,
      `Unexpected properties on ${this.describe()}: [${untouched.join(', ')}]. ` +
        `Assert them, or call etc() to allow them.`
    )

    return this
  }
}

/**
 * Does the body match this structure — keys only, values ignored?
 *
 * `*` means "every element of this array has the structure below", which is the
 * one place a wildcard earns its place: the alternative is asserting a shape
 * once per element for a list of unknown length.
 */
export function matchesStructure(
  value: unknown,
  structure: unknown,
  path = ''
): string | undefined {
  const where = path === '' ? 'the root' : `[${path}]`

  if (Array.isArray(structure)) {
    // A list structure: `['id', 'name']` means those keys must be present.
    for (const key of structure) {
      if (typeof key !== 'string') continue
      if (!dataHas(value, key))
        return `Expected ${where} to have property [${key}], saw ${show(value)}`
    }

    return undefined
  }

  if (structure === null || typeof structure !== 'object') return undefined

  const shape = structure as Record<string, unknown>

  if ('*' in shape) {
    if (!Array.isArray(value)) return `Expected ${where} to be an array, saw ${show(value)}`

    for (const [index, item] of value.entries()) {
      const failure = matchesStructure(
        item,
        shape['*'],
        path === '' ? String(index) : `${path}.${index}`
      )
      if (failure) return failure
    }

    return undefined
  }

  for (const [key, child] of Object.entries(shape)) {
    if (!dataHas(value, key))
      return `Expected ${where} to have property [${key}], saw ${show(value)}`

    const failure = matchesStructure(
      dataGet(value, key),
      child,
      path === '' ? key : `${path}.${key}`
    )
    if (failure) return failure
  }

  return undefined
}
