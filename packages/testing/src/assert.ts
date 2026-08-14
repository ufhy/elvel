/**
 * A failed assertion.
 *
 * Deliberately not `bun:test`'s `expect`. Binding the package to a test runner
 * would stop it being usable from `scripts/smoke.ts`, which runs under plain
 * `bun` and is where the scaffolded application is actually exercised. A thrown
 * error is a failure in every runner, so throwing costs nothing and buys reach.
 *
 * The price is the diff: `expect` prints a coloured one and this prints what it
 * was given, so the message has to carry its own context. That is why every
 * assertion below spells out what it looked at rather than only what it wanted.
 */
export class AssertionError extends Error {
  constructor(
    message: string,
    readonly expected?: unknown,
    readonly actual?: unknown
  ) {
    super(message)
    this.name = 'AssertionError'
  }
}

export function fail(message: string, expected?: unknown, actual?: unknown): never {
  throw new AssertionError(message, expected, actual)
}

export function assert(
  passed: boolean,
  message: string,
  expected?: unknown,
  actual?: unknown
): void {
  if (!passed) fail(message, expected, actual)
}

/** Readable in a message: short strings inline, everything else as JSON. */
export function show(value: unknown, limit = 240): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'

  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }

  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Structural equality, order-sensitive for arrays.
 *
 * `JSON.stringify` comparison would be shorter and wrong: it makes key order
 * significant, so `{a,b}` and `{b,a}` would differ. A response body's key order
 * is not something a test should depend on.
 */
export function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false

    return a.every((item, index) => equals(item, b[index]))
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false

  return keys.every((key) => key in right && equals(left[key], right[key]))
}

/**
 * Is `subset` contained in `value`, recursively?
 *
 * What `assertJson` means by "contains": every key named must match, and keys
 * not named are ignored. An array in the subset must appear in order but need
 * not be the whole array.
 */
export function contains(value: unknown, subset: unknown): boolean {
  if (subset === null || typeof subset !== 'object') return equals(value, subset)

  if (Array.isArray(subset)) {
    if (!Array.isArray(value)) return false

    return subset.every((item) => value.some((candidate) => contains(candidate, item)))
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false

  const haystack = value as Record<string, unknown>

  return Object.entries(subset as Record<string, unknown>).every(
    ([key, expected]) => key in haystack && contains(haystack[key], expected)
  )
}

/**
 * Read `a.b.0.c` out of a decoded body.
 *
 * `*` is not supported, unlike Laravel's. Wildcards there exist because PHP has
 * no cheap way to map over a nested array in an assertion; here `assertJsonPath`
 * can be handed a callback, and a callback says more than a wildcard can.
 */
export function dataGet(target: unknown, path: string): unknown {
  if (path === '') return target

  let current = target
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined

    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }

    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

/** Does the path exist at all — as opposed to holding `undefined`? */
export function dataHas(target: unknown, path: string): boolean {
  if (path === '') return target !== undefined

  const segments = path.split('.')
  const last = segments.pop() as string
  const parent = dataGet(target, segments.join('.'))

  if (parent === null || parent === undefined) return false
  if (Array.isArray(parent)) {
    const index = Number(last)

    return Number.isInteger(index) && index >= 0 && index < parent.length
  }

  return typeof parent === 'object' && last in (parent as Record<string, unknown>)
}
