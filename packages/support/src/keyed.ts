import { Collection } from './collection.ts'
import { Macroable } from './macroable.ts'

/** A key a JavaScript object could also have held. */
export type Key = string | number

/**
 * The keyed half of a collection.
 *
 * `keyBy` and `mapWithKeys` used to answer with a plain object, which ended the
 * chain: no `map`, no `filter`, no `each`, so the caller dropped back to bare
 * objects for the rest of the pipeline — the exact thing the collection exists
 * to prevent. This is what they answer with instead.
 *
 * A `Map` underneath, not an object, so a numeric key stays a number and
 * insertion order is the order — neither of which an object promises.
 */
export class KeyedCollection<K extends Key, V> extends Macroable implements Iterable<[K, V]> {
  private readonly entries_: Map<K, V>

  constructor(entries: Iterable<[K, V]> = []) {
    super()
    this.entries_ = new Map(entries)
  }

  static make<K extends Key, V>(entries: Iterable<[K, V]> = []): KeyedCollection<K, V> {
    return new KeyedCollection(entries)
  }

  /** From a plain object, which is what a JSON payload arrives as. */
  static from<V>(target: Record<string, V>): KeyedCollection<string, V> {
    return new KeyedCollection(Object.entries(target))
  }

  /** One list for the keys and one for the values, zipped. */
  static combine<K extends Key, V>(keys: Iterable<K>, values: Iterable<V>): KeyedCollection<K, V> {
    const rest = [...values]

    return new KeyedCollection([...keys].map((key, index) => [key, rest[index] as V]))
  }

  [Symbol.iterator](): Iterator<[K, V]> {
    return this.entries_[Symbol.iterator]()
  }

  // ----------------------------------------------------------------- reading

  get(key: K): V | undefined
  get(key: K, fallback: V): V
  get(key: K, fallback?: V): V | undefined {
    return this.entries_.has(key) ? this.entries_.get(key) : fallback
  }

  has(key: K): boolean {
    return this.entries_.has(key)
  }

  hasAny(keys: K[]): boolean {
    return keys.some((key) => this.entries_.has(key))
  }

  hasAll(keys: K[]): boolean {
    return keys.every((key) => this.entries_.has(key))
  }

  keys(): Collection<K> {
    return new Collection([...this.entries_.keys()])
  }

  /** Back to a list, which is where most chains end. */
  values(): Collection<V> {
    return new Collection([...this.entries_.values()])
  }

  entries(): Collection<[K, V]> {
    return new Collection([...this.entries_])
  }

  count(): number {
    return this.entries_.size
  }

  get size(): number {
    return this.entries_.size
  }

  isEmpty(): boolean {
    return this.entries_.size === 0
  }

  isNotEmpty(): boolean {
    return this.entries_.size > 0
  }

  first(): V | undefined {
    for (const [, value] of this.entries_) return value

    return undefined
  }

  // ---------------------------------------------------------------- mutating

  /** Mutates, because that is what a keyed store is for. */
  put(key: K, value: V): this {
    this.entries_.set(key, value)

    return this
  }

  /** Read it, or compute and store it in one step. */
  getOrPut(key: K, build: () => V): V {
    if (this.entries_.has(key)) return this.entries_.get(key) as V

    const built = build()
    this.entries_.set(key, built)

    return built
  }

  forget(...keys: K[]): this {
    for (const key of keys) this.entries_.delete(key)

    return this
  }

  /** Read a key out and remove it, in one step. */
  pull(key: K, fallback?: V): V | undefined {
    const value = this.get(key, fallback as V)
    this.entries_.delete(key)

    return value
  }

  // ---------------------------------------------------------------- reshaping

  /** Keys become values and values become keys. */
  flip(): KeyedCollection<Key, K> {
    return new KeyedCollection([...this.entries_].map(([key, value]) => [value as Key, key]))
  }

  /** Keep the values this one already has; take the rest from the other. */
  union(other: KeyedCollection<K, V> | Record<string, V>): KeyedCollection<K, V> {
    const merged = new KeyedCollection<K, V>(asEntries(other) as Array<[K, V]>)

    for (const [key, value] of this.entries_) merged.put(key, value)

    return merged
  }

  /** The other one wins, which is the other half of `union`. */
  merge(other: KeyedCollection<K, V> | Record<string, V>): KeyedCollection<K, V> {
    const merged = new KeyedCollection<K, V>(this.entries_)

    for (const [key, value] of asEntries(other)) merged.put(key as K, value as V)

    return merged
  }

  /** `replace` is `merge` under the name upstream gives it. */
  replace(other: KeyedCollection<K, V> | Record<string, V>): KeyedCollection<K, V> {
    return this.merge(other)
  }

  /** The same, one level down as well, for a nested settings object. */
  replaceRecursive(other: KeyedCollection<K, V> | Record<string, V>): KeyedCollection<K, V> {
    const merged = new KeyedCollection<K, V>(this.entries_)

    for (const [key, value] of asEntries(other)) {
      const existing = merged.get(key as K)

      merged.put(
        key as K,
        (isPlain(existing) && isPlain(value) ? deepMerge(existing, value) : value) as V
      )
    }

    return merged
  }

  /** Nested merge where a list is appended rather than replaced. */
  mergeRecursive(other: KeyedCollection<K, V> | Record<string, V>): KeyedCollection<K, V> {
    const merged = new KeyedCollection<K, V>(this.entries_)

    for (const [key, value] of asEntries(other)) {
      const existing = merged.get(key as K)

      if (Array.isArray(existing) && Array.isArray(value)) {
        merged.put(key as K, [...existing, ...value] as V)

        continue
      }

      merged.put(
        key as K,
        (isPlain(existing) && isPlain(value) ? deepMerge(existing, value) : value) as V
      )
    }

    return merged
  }

  only(keys: K[]): KeyedCollection<K, V> {
    return new KeyedCollection(
      keys.filter((key) => this.entries_.has(key)).map((key) => [key, this.entries_.get(key) as V])
    )
  }

  except(keys: K[]): KeyedCollection<K, V> {
    const dropped = new Set<K>(keys)

    return this.filter((_value, key) => !dropped.has(key))
  }

  /** Entries whose key the other does not have. */
  diffKeys(other: KeyedCollection<K, unknown> | Record<string, unknown>): KeyedCollection<K, V> {
    const theirs = new Set(asEntries(other).map(([key]) => String(key)))

    return this.filter((_value, key) => !theirs.has(String(key)))
  }

  /** Entries the other does not have with the same value. */
  diffAssoc(other: KeyedCollection<K, V> | Record<string, V>): KeyedCollection<K, V> {
    const theirs = new Map(asEntries(other).map(([key, value]) => [String(key), value]))

    return this.filter((value, key) => theirs.get(String(key)) !== value)
  }

  intersectByKeys(
    other: KeyedCollection<K, unknown> | Record<string, unknown>
  ): KeyedCollection<K, V> {
    const theirs = new Set(asEntries(other).map(([key]) => String(key)))

    return this.filter((_value, key) => theirs.has(String(key)))
  }

  intersectAssoc(other: KeyedCollection<K, V> | Record<string, V>): KeyedCollection<K, V> {
    const theirs = new Map(asEntries(other).map(([key, value]) => [String(key), value]))

    return this.filter((value, key) => theirs.get(String(key)) === value)
  }

  prependKeysWith(prefix: string): KeyedCollection<string, V> {
    return new KeyedCollection([...this.entries_].map(([key, value]) => [`${prefix}${key}`, value]))
  }

  // ------------------------------------------------------------------ walking

  /** Over the values, keeping the keys — the whole reason this type exists. */
  map<U>(callback: (value: V, key: K) => U): KeyedCollection<K, U> {
    return new KeyedCollection(
      [...this.entries_].map(([key, value]) => [key, callback(value, key)])
    )
  }

  /** Both halves are rewritten. */
  mapWithKeys<K2 extends Key, U>(callback: (value: V, key: K) => [K2, U]): KeyedCollection<K2, U> {
    return new KeyedCollection([...this.entries_].map(([key, value]) => callback(value, key)))
  }

  /** Just the keys. */
  mapKeys<K2 extends Key>(callback: (key: K, value: V) => K2): KeyedCollection<K2, V> {
    return new KeyedCollection(
      [...this.entries_].map(([key, value]) => [callback(key, value), value])
    )
  }

  filter(predicate: (value: V, key: K) => boolean): KeyedCollection<K, V> {
    return new KeyedCollection([...this.entries_].filter(([key, value]) => predicate(value, key)))
  }

  reject(predicate: (value: V, key: K) => boolean): KeyedCollection<K, V> {
    return this.filter((value, key) => !predicate(value, key))
  }

  each(callback: (value: V, key: K) => unknown): this {
    for (const [key, value] of this.entries_) {
      if (callback(value, key) === false) break
    }

    return this
  }

  /** Reduce with the key in hand, which a list cannot offer. */
  reduceWithKeys<U>(callback: (carry: U, value: V, key: K) => U, initial: U): U {
    let carry = initial

    for (const [key, value] of this.entries_) carry = callback(carry, value, key)

    return carry
  }

  sortKeys(): KeyedCollection<K, V> {
    return this.sortKeysUsing((left, right) => String(left).localeCompare(String(right)))
  }

  sortKeysDesc(): KeyedCollection<K, V> {
    return this.sortKeysUsing((left, right) => String(right).localeCompare(String(left)))
  }

  sortKeysUsing(compare: (left: K, right: K) => number): KeyedCollection<K, V> {
    return new KeyedCollection([...this.entries_].sort(([left], [right]) => compare(left, right)))
  }

  pipe<U>(callback: (keyed: this) => U): U {
    return callback(this)
  }

  tap(callback: (keyed: this) => unknown): this {
    callback(this)

    return this
  }

  // ------------------------------------------------------------------ leaving

  /** Flatten to `{ 'a.b': 1 }`, which is what a form or a config file speaks. */
  dot(prefix = ''): KeyedCollection<string, unknown> {
    const flat: Array<[string, unknown]> = []

    const walk = (value: unknown, at: string): void => {
      if (isPlain(value) && Object.keys(value).length > 0) {
        for (const [key, nested] of Object.entries(value))
          walk(nested, at === '' ? key : `${at}.${key}`)

        return
      }

      flat.push([at, value])
    }

    for (const [key, value] of this.entries_) walk(value, `${prefix}${String(key)}`)

    return new KeyedCollection(flat)
  }

  /** And back again. */
  undot(): KeyedCollection<string, unknown> {
    const out: Record<string, unknown> = {}

    for (const [key, value] of this.entries_) {
      const segments = String(key).split('.')
      let current = out

      for (const segment of segments.slice(0, -1)) {
        if (!isPlain(current[segment])) current[segment] = {}

        current = current[segment] as Record<string, unknown>
      }

      current[segments[segments.length - 1] as string] = value
    }

    return KeyedCollection.from(out)
  }

  /** A plain object, for a JSON response or anything that wants one. */
  toObject(): Record<string, V> {
    return Object.fromEntries([...this.entries_].map(([key, value]) => [String(key), value]))
  }

  all(): Record<string, V> {
    return this.toObject()
  }

  toMap(): Map<K, V> {
    return new Map(this.entries_)
  }

  toJSON(): Record<string, V> {
    return this.toObject()
  }
}

/** Both shapes a keyed argument arrives in. */
function asEntries(
  source: KeyedCollection<Key, unknown> | Record<string, unknown>
): Array<[Key, unknown]> {
  return source instanceof KeyedCollection
    ? [...source]
    : (Object.entries(source) as Array<[Key, unknown]>)
}

/** An object that is a bag of keys, rather than a class instance or an array. */
function isPlain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function deepMerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...left }

  for (const [key, value] of Object.entries(right)) {
    const existing = out[key]

    out[key] = isPlain(existing) && isPlain(value) ? deepMerge(existing, value) : value
  }

  return out
}

/** `keyed({ a: 1 })` reads the way `collect([…])` does. */
export function keyed<V>(source: Record<string, V> = {}): KeyedCollection<string, V> {
  return KeyedCollection.from(source)
}
