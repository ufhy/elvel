type Dict = Record<string, any>

/**
 * Read a nested value using dot notation.
 *
 * Declared as a standalone function because object literals cannot carry
 * overloads, and the overloads matter: with a single `fallback?: T` signature
 * TypeScript infers `T` as `undefined` whenever the fallback is omitted.
 */
function get<T = unknown>(target: Dict, key: string): T
function get<T>(target: Dict, key: string, fallback: T): T
function get<T>(target: Dict, key: string, fallback?: T): T {
  if (key === '') return target as unknown as T

  let current: unknown = target
  for (const segment of key.split('.')) {
    if (current === null || typeof current !== 'object') return fallback as T
    current = (current as Dict)[segment]
    if (current === undefined) return fallback as T
  }

  return current as T
}

/**
 * Array/object helpers. The dot-notation accessors here are what make
 * `config('app.name')` work.
 */
export const Arr = {
  wrap<T>(value: T | T[] | null | undefined): T[] {
    if (value === null || value === undefined) return []
    return Array.isArray(value) ? value : [value]
  },

  get,

  /**
   * Write a nested value using dot notation, creating what is missing.
   *
   * A **numeric** segment creates an array, not an object. PHP cannot tell the
   * two apart, so Laravel's `data_set` never had to decide; here it matters —
   * rebuilding `items.0.price` into `{ items: { '0': … } }` produces something
   * that serialises as an object, and a validated payload that reaches a database
   * write or a JSON response in that shape is wrong in a way nothing catches
   * until it is in front of a user.
   */
  set(target: Dict, key: string, value: unknown): Dict {
    const segments = key.split('.')
    let current: Dict = target

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string
      const next = current[segment]

      if (next === null || typeof next !== 'object') {
        current[segment] = /^\d+$/.test(segments[index + 1] as string) ? [] : {}
      }

      current = current[segment] as Dict
    }

    current[segments[segments.length - 1] as string] = value
    return target
  },

  has(target: Dict, key: string): boolean {
    const missing = Symbol('missing')
    return Arr.get(target, key, missing as unknown) !== missing
  },

  forget(target: Dict, key: string): Dict {
    const segments = key.split('.')
    let current: Dict = target

    for (let index = 0; index < segments.length - 1; index += 1) {
      const next = current[segments[index] as string]
      if (next === null || typeof next !== 'object') return target
      current = next as Dict
    }

    delete current[segments[segments.length - 1] as string]
    return target
  },

  only<T extends Dict, K extends keyof T>(target: T, keys: K[]): Pick<T, K> {
    const result = {} as Pick<T, K>
    for (const key of keys) {
      if (key in target) result[key] = target[key]
    }
    return result
  },

  except<T extends Dict, K extends keyof T>(target: T, keys: K[]): Omit<T, K> {
    const result = { ...target }
    for (const key of keys) delete result[key]
    return result as Omit<T, K>
  },

  /** Flatten a nested object into dot-notation keys. */
  dot(target: Dict, prefix = ''): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(target)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      const isPlainObject =
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date)

      if (isPlainObject && Object.keys(value as Dict).length > 0) {
        Object.assign(result, Arr.dot(value as Dict, path))
      } else {
        result[path] = value
      }
    }

    return result
  },

  flatten<T>(values: unknown[], depth = Number.POSITIVE_INFINITY): T[] {
    return values.flat(depth) as T[]
  },

  unique<T>(values: T[]): T[] {
    return [...new Set(values)]
  },

  first<T>(values: T[], predicate?: (value: T) => boolean): T | undefined {
    if (!predicate) return values[0]
    return values.find(predicate)
  },

  last<T>(values: T[]): T | undefined {
    return values[values.length - 1]
  },

  groupBy<T>(values: T[], key: (value: T) => string): Record<string, T[]> {
    const result: Record<string, T[]> = {}
    for (const value of values) {
      const group = key(value)
      const bucket = result[group] ?? []
      bucket.push(value)
      result[group] = bucket
    }
    return result
  },

  sortBy<T>(values: T[], key: (value: T) => string | number): T[] {
    return [...values].sort((a, b) => {
      const left = key(a)
      const right = key(b)
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })
  }
}
