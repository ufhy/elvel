import { type Macroed, macroable } from './macroable.ts'

type Dict = Record<string, any>

/**
 * Refuse a segment that would reach the prototype chain, and hand back the rest.
 *
 * `Arr.set(target, '__proto__.isAdmin', true)` does not write a property called
 * `__proto__`; it walks into `Object.prototype` and writes *there*, and from
 * that moment every object in the process answers `isAdmin` — including ones
 * built long before, and ones the attacker never touched. PHP arrays have no
 * prototype, so a dotted setter there never had to decide this; the API is
 * inherited and the hazard with it.
 *
 * It returns the segment rather than returning nothing, so that every write
 * below reads `current[refusePrototypeWalk(...)]` and there is no way to add a
 * new one that forgets to ask.
 *
 * Refused loudly rather than ignored: a key of that shape is an attack or a bug,
 * and dropping the write in silence leaves the caller believing it stored
 * something.
 */
function refusePrototypeWalk(key: string, segment: string): string {
  if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
    throw new Error(`[${key}] walks through [${segment}], which would reach the prototype chain.`)
  }

  return segment
}

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
/**
 * The sentinel `has` looks for, made once.
 *
 * A fresh `Symbol('missing')` per call made `Arr.has` five times the cost of the
 * `Arr.get` it wraps — 0.069µs against 0.013µs — and it sits under `Config.has`
 * and under most validation rules. A module-level symbol is still unforgeable by
 * a caller, which is the only property that mattered.
 */
const MISSING = Symbol('missing')

/** Macros added to `Arr`. A package declaring its own merges into this. */
export type ArrMacros = {}

const methods = {
  wrap<T>(value: T | T[] | null | undefined): T[] {
    if (value === null || value === undefined) return []
    return Array.isArray(value) ? value : [value]
  },

  get,

  /**
   * Write a nested value using dot notation, creating what is missing.
   *
   * A **numeric** segment creates an array, not an object. PHP cannot tell the
   * two apart, so a dotted setter there never had to decide; here it matters —
   * rebuilding `items.0.price` into `{ items: { '0': … } }` produces something
   * that serialises as an object, and a validated payload that reaches a database
   * write or a JSON response in that shape is wrong in a way nothing catches
   * until it is in front of a user.
   *
   * A segment of `__proto__`, `constructor` or `prototype` is refused. Such a key
   * does not write a property of that name; it walks into `Object.prototype` and
   * writes *there*, and from that moment every object in the process answers
   * `isAdmin` — including ones built long before, and ones the attacker never
   * touched. PHP arrays have no prototype, so a dotted setter there never had to
   * decide this either; the API is inherited and the hazard with it.
   *
   * Refused loudly rather than ignored: a key of that shape is an attack or a
   * bug, and dropping the write in silence leaves the caller believing it stored
   * something.
   */
  set(target: Dict, key: string, value: unknown): Dict {
    const segments = key.split('.')
    let current: Dict = target

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = refusePrototypeWalk(key, segments[index] as string)
      const next = current[segment]

      if (next === null || typeof next !== 'object') {
        current[segment] = /^\d+$/.test(segments[index + 1] as string) ? [] : {}
      }

      current = current[segment] as Dict
    }

    current[refusePrototypeWalk(key, segments[segments.length - 1] as string)] = value
    return target
  },

  has(target: Dict, key: string): boolean {
    return Arr.get(target, key, MISSING as unknown) !== MISSING
  },

  forget(target: Dict, key: string): Dict {
    const segments = key.split('.')
    let current: Dict = target

    for (let index = 0; index < segments.length - 1; index += 1) {
      const next = current[refusePrototypeWalk(key, segments[index] as string)]
      if (next === null || typeof next !== 'object') return target
      current = next as Dict
    }

    // `delete Object.prototype.toString` is the same hole pointing the other way.
    delete current[refusePrototypeWalk(key, segments[segments.length - 1] as string)]
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
  },

  // ------------------------------------------------------------ reading

  hasAny(target: unknown, paths: string[]): boolean {
    return paths.some((path) => Arr.has(target as Record<string, unknown>, path))
  },

  /** Is it a plain list — `[1, 2]` rather than `{ a: 1 }`? */
  isList(value: unknown): boolean {
    return Array.isArray(value)
  },

  isAssoc(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  },

  // --------------------------------------------------------- transforming

  /** The reverse of `dot`: `{'a.b': 1}` becomes `{a: {b: 1}}`. */
  undot(flat: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}

    for (const [path, value] of Object.entries(flat)) Arr.set(out, path, value)

    return out
  },

  /** One level down. */
  collapse<T>(rows: Array<T[] | T>): T[] {
    return rows.flatMap((row) => (Array.isArray(row) ? row : [row]))
  },

  /** Keys and values as two lists. */
  divide<T>(target: Record<string, T>): [string[], T[]] {
    return [Object.keys(target), Object.values(target)]
  },

  /** One column out of a list of rows, optionally keyed by another. */
  pluck<T extends Record<string, unknown>>(rows: T[], value: string, key?: string): unknown {
    if (key === undefined) return rows.map((row) => Arr.get(row, value))

    return Object.fromEntries(rows.map((row) => [String(Arr.get(row, key)), Arr.get(row, value)]))
  },

  /** Rows keyed by one of their own columns; a later duplicate wins. */
  keyBy<T extends Record<string, unknown>>(rows: T[], key: string): Record<string, T> {
    return Object.fromEntries(rows.map((row) => [String(Arr.get(row, key)), row]))
  },

  mapWithKeys<T, K extends string, V>(items: T[], callback: (item: T) => [K, V]): Record<K, V> {
    return Object.fromEntries(items.map(callback)) as Record<K, V>
  },

  /** Call the callback with each row spread as arguments. */
  mapSpread<T extends unknown[], U>(rows: T[], callback: (...args: T) => U): U[] {
    return rows.map((row) => callback(...row))
  },

  /** Those that pass, and those that do not. */
  partition<T>(items: T[], predicate: (item: T, index: number) => boolean): [T[], T[]] {
    const pass: T[] = []
    const fail: T[] = []

    for (const [index, item] of items.entries()) {
      ;(predicate(item, index) ? pass : fail).push(item)
    }

    return [pass, fail]
  },

  reject<T>(items: T[], predicate: (item: T, index: number) => boolean): T[] {
    return items.filter((item, index) => !predicate(item, index))
  },

  /** Every combination, one item from each list. */
  crossJoin<T>(...lists: T[][]): T[][] {
    return lists.reduce<T[][]>(
      (rows, list) => rows.flatMap((row) => list.map((value) => [...row, value])),
      [[]]
    )
  },

  /** Add to the front. */
  prepend<T>(items: T[], value: T): T[] {
    return [value, ...items]
  },

  /** Read a key out and remove it, in one step. */
  pull<T extends Record<string, unknown>>(target: T, path: string): unknown {
    const value = Arr.get(target, path)
    Arr.forget(target, path)

    return value
  },

  /** A query string from a nested object. */
  query(target: Record<string, unknown>): string {
    const parameters = new URLSearchParams()

    for (const [key, value] of Object.entries(Arr.dot(target))) {
      if (value === undefined || value === null) continue
      parameters.set(key, String(value))
    }

    return parameters.toString()
  },

  /** One at random, or `count` of them. */
  random<T>(items: T[], count?: number): T | T[] | undefined {
    if (items.length === 0) return count === undefined ? undefined : []

    const shuffled = Arr.shuffle(items)

    return count === undefined ? shuffled[0] : shuffled.slice(0, count)
  },

  /** Fisher–Yates, not `sort(() => Math.random() - 0.5)`, which is not a shuffle. */
  shuffle<T>(items: T[]): T[] {
    const out = [...items]

    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1))
      ;[out[index], out[swap]] = [out[swap] as T, out[index] as T]
    }

    return out
  },

  /** Exactly one, or an error. */
  sole<T>(items: T[], predicate?: (item: T, index: number) => boolean): T {
    const matched = predicate ? items.filter(predicate) : items

    if (matched.length === 0) throw new Error('No matching item.')
    if (matched.length > 1) throw new Error(`Expected one matching item, found ${matched.length}.`)

    return matched[0] as T
  },

  /** Set a dotted key only when nothing is there — a default, not an overwrite. */
  add(target: Dict, key: string, value: unknown): Dict {
    const existing = Arr.get(target, key)

    if (existing === undefined || existing === null) Arr.set(target, key, value)

    return target
  },

  /** The complement of `hasAny`: every path, not any of them. */
  hasAll(target: unknown, paths: string[]): boolean {
    return paths.every((path) => Arr.has(target as Dict, path))
  },

  /** `prependKeysWith({ a: 1 }, 'meta.')` — how a payload is namespaced. */
  prependKeysWith(target: Dict, prefix: string): Dict {
    return Object.fromEntries(
      Object.entries(target).map(([key, value]) => [`${prefix}${key}`, value])
    )
  },

  /** The same keys out of every row — a projection over a list of records. */
  select<T extends Dict, K extends keyof T & string>(rows: T[], keys: K[]): Array<Pick<T, K>> {
    return rows.map((row) => Arr.only(row, keys))
  },

  /** Drop the nulls, which `filter(Boolean)` cannot do without dropping `0` too. */
  whereNotNull<T>(items: Array<T | null | undefined>): T[] {
    return items.filter((item): item is T => item !== null && item !== undefined)
  },

  /** The values behind those keys, in the order asked for. */
  onlyValues<T extends Dict, K extends keyof T & string>(target: T, keys: K[]): Array<T[K]> {
    return keys.filter((key) => key in target).map((key) => target[key])
  },

  /** Everything else's values. */
  exceptValues<T extends Dict, K extends keyof T & string>(target: T, keys: K[]): unknown[] {
    return Object.values(Arr.except(target, keys))
  },

  /** Sort every level, so two structures can be compared or hashed. */
  sortRecursive<T>(value: T, descending = false): T {
    if (Array.isArray(value)) {
      const sorted = value.map((entry) => Arr.sortRecursive(entry, descending))

      // A list of objects has no order to give it, so only scalars are sorted.
      if (sorted.every((entry) => entry === null || typeof entry !== 'object')) {
        sorted.sort((left, right) => String(left).localeCompare(String(right)))

        if (descending) sorted.reverse()
      }

      return sorted as T
    }

    if (value === null || typeof value !== 'object') return value

    const keys = Object.keys(value as Dict).sort()

    if (descending) keys.reverse()

    return Object.fromEntries(
      keys.map((key) => [key, Arr.sortRecursive((value as Dict)[key], descending)])
    ) as T
  },

  sortRecursiveDesc<T>(value: T): T {
    return Arr.sortRecursive(value, true)
  },

  /**
   * Read a dotted key and insist on its type.
   *
   * A JSON body is `unknown` however it was typed at the call site, so this is
   * the difference between a checked read and a cast that lies about what
   * arrived. Named for the type rather than the check, so the call site reads as
   * the thing it wants: `Arr.integer(body, 'page')`.
   */
  string(target: Dict, key: string, fallback?: string): string {
    const value = Arr.get<unknown>(target, key, fallback)

    if (typeof value === 'string') return value

    throw new ArrTypeError(key, 'a string', value)
  },

  integer(target: Dict, key: string, fallback?: number): number {
    const value = numberAt(target, key, fallback)

    if (Number.isInteger(value)) return value

    throw new ArrTypeError(key, 'an integer', Arr.get<unknown>(target, key, fallback))
  },

  float(target: Dict, key: string, fallback?: number): number {
    return numberAt(target, key, fallback)
  },

  /** `'true'`, `'1'`, `'on'` and `'yes'` are true, because `Boolean('false')` is not. */
  boolean(target: Dict, key: string, fallback?: boolean): boolean {
    const value = Arr.get<unknown>(target, key, fallback)

    if (typeof value === 'boolean') return value

    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase()

      if (['true', '1', 'on', 'yes'].includes(lowered)) return true
      if (['false', '0', 'off', 'no', ''].includes(lowered)) return false
    }

    throw new ArrTypeError(key, 'a boolean', value)
  },

  array<T = unknown>(target: Dict, key: string, fallback?: T[]): T[] {
    const value = Arr.get<unknown>(target, key, fallback)

    if (Array.isArray(value)) return value as T[]

    throw new ArrTypeError(key, 'an array', value)
  }
}

/** A numeric string counts, because a query parameter has no other way to say it. */
function numberAt(target: Dict, key: string, fallback?: number): number {
  const value = Arr.get<unknown>(target, key, fallback)

  if (typeof value === 'number' && Number.isFinite(value)) return value

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)

    if (Number.isFinite(parsed)) return parsed
  }

  throw new ArrTypeError(key, 'a number', value)
}

/** Names the key and what was actually there, because a stack says neither. */
export class ArrTypeError extends Error {
  constructor(
    readonly key: string,
    expected: string,
    readonly actual: unknown
  ) {
    super(`[${key}] should be ${expected}, and it is ${describeValue(actual)}.`)
    this.name = 'ArrTypeError'
  }
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'missing'
  if (Array.isArray(value)) return 'an array'

  return `${typeof value} (${JSON.stringify(value)})`
}

export const Arr: typeof methods & Macroed & ArrMacros = macroable(methods)
