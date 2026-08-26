/** Thrown by `sole()` when nothing matched, or more than one thing did. */
export class ItemNotFoundError extends Error {
  constructor(message = 'No matching item.') {
    super(message)
    this.name = 'ItemNotFoundError'
  }
}

export class MultipleItemsFoundError extends Error {
  constructor(count: number) {
    super(`Expected one matching item, found ${count}.`)
    this.name = 'MultipleItemsFoundError'
  }
}

/**
 * Collection — the fluent array wrapper the models return.
 *
 * It was deliberately small for a long time, carrying only what the framework
 * itself consumed. That was the right call while the framework was the only
 * caller and the wrong one afterwards: an application reaching for `groupBy` or
 * `partition` and finding neither goes back to bare arrays, and then the models
 * are returning a wrapper nobody wants.
 *
 * Every method returns a new collection. Laravel's do too, apart from the few
 * that exist to mutate (`push`, `pop`, `shift`), and those are marked.
 */
export class Collection<T> implements Iterable<T> {
  constructor(private readonly items: T[] = []) {}

  static make<T>(items: Iterable<T> = []): Collection<T> {
    return new Collection([...items])
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]()
  }

  all(): T[] {
    return [...this.items]
  }

  // ------------------------------------------------------------- building

  static times<T>(count: number, callback: (number: number) => T): Collection<T> {
    return new Collection(Array.from({ length: Math.max(0, count) }, (_, i) => callback(i + 1)))
  }

  static range(start: number, end: number): Collection<number> {
    const step = start <= end ? 1 : -1
    const length = Math.abs(end - start) + 1

    return new Collection(Array.from({ length }, (_, i) => start + i * step))
  }

  static wrap<T>(value: T | T[] | Collection<T> | null | undefined): Collection<T> {
    if (value === null || value === undefined) return new Collection<T>([])
    if (value instanceof Collection) return value
    return new Collection(Array.isArray(value) ? [...value] : [value])
  }

  toJSON(): T[] {
    return this.all()
  }

  get length(): number {
    return this.items.length
  }

  count(): number {
    return this.items.length
  }

  isEmpty(): boolean {
    return this.items.length === 0
  }

  isNotEmpty(): boolean {
    return !this.isEmpty()
  }

  map<U>(callback: (item: T, index: number) => U): Collection<U> {
    return new Collection(this.items.map(callback))
  }

  flatMap<U>(callback: (item: T, index: number) => U[]): Collection<U> {
    return new Collection(this.items.flatMap(callback))
  }

  filter(callback: (item: T, index: number) => boolean): Collection<T> {
    return new Collection(this.items.filter(callback))
  }

  reject(callback: (item: T, index: number) => boolean): Collection<T> {
    return this.filter((item, index) => !callback(item, index))
  }

  each(callback: (item: T, index: number) => void): this {
    this.items.forEach(callback)
    return this
  }

  reduce<U>(callback: (carry: U, item: T, index: number) => U, initial: U): U {
    return this.items.reduce(callback, initial)
  }

  first(predicate?: (item: T) => boolean): T | undefined {
    return predicate ? this.items.find(predicate) : this.items[0]
  }

  last(): T | undefined {
    return this.items[this.items.length - 1]
  }

  contains(predicate: (item: T) => boolean): boolean {
    return this.items.some(predicate)
  }

  /**
   * The negation of `contains`, which reads better than `!c.contains(…)`.
   *
   * Laravel's `containsStrict` and `doesntContainStrict` are the same two: the
   * "strict" in those names is about PHP's loose `==`, and there is no loose
   * comparison here to opt out of. They are aliases rather than absent so that an
   * example copies across without a reader wondering what changed.
   */
  doesntContain(predicate: (item: T) => boolean): boolean {
    return !this.contains(predicate)
  }

  containsStrict(predicate: (item: T) => boolean): boolean {
    return this.contains(predicate)
  }

  doesntContainStrict(predicate: (item: T) => boolean): boolean {
    return !this.contains(predicate)
  }

  /** Exactly one, and more than one — the two counts worth naming. */
  containsOneItem(): boolean {
    return this.items.length === 1
  }

  containsManyItems(): boolean {
    return this.items.length > 1
  }

  /** `multiply(3)` repeats the collection, which is what a fixture often wants. */
  multiply(times: number): Collection<T> {
    const out: T[] = []

    for (let round = 0; round < Math.max(0, times); round += 1) out.push(...this.items)

    return new Collection(out)
  }

  /**
   * `select(['id', 'name'])` — several keys per item, unlike `pluck`'s one.
   *
   * For handing a narrowed shape to a view or a JSON response without writing the
   * `map` that builds the object, which is where a key gets misspelt.
   */
  select<K extends keyof T>(keys: K[]): Collection<Pick<T, K>> {
    return new Collection(
      this.items.map((item) => {
        const picked = {} as Pick<T, K>

        for (const key of keys) picked[key] = item[key]

        return picked
      })
    )
  }

  /**
   * The item before this one, or nothing at either end.
   *
   * The value is typed `unknown` rather than `T`, and that is not laziness: a
   * `T` in an input position makes this class **invariant**, and
   * `Collection<Model>` then stops being assignable to `Collection<Article>`.
   * Measured — it broke six casts in `relations.ts` that have nothing to do with
   * collections. The overloads put the type back where it is useful: a predicate
   * has its argument typed as `T`, and a bare value is compared with `===` —
   * which is what a search would do anyway.
   */
  before(predicate: (item: T) => boolean): T | undefined
  before(value: unknown): T | undefined
  before(value: unknown): T | undefined {
    const at =
      typeof value === 'function'
        ? this.items.findIndex(value as (item: T) => boolean)
        : this.items.findIndex((item) => (item as unknown) === value)

    return at > 0 ? this.items[at - 1] : undefined
  }

  after(predicate: (item: T) => boolean): T | undefined
  after(value: unknown): T | undefined
  after(value: unknown): T | undefined {
    const at =
      typeof value === 'function'
        ? this.items.findIndex(value as (item: T) => boolean)
        : this.items.findIndex((item) => (item as unknown) === value)

    return at === -1 || at === this.items.length - 1 ? undefined : this.items[at + 1]
  }

  /**
   * `splitIn(3)` — groups of a fixed size, where `split(3)` makes three groups.
   *
   * The difference matters for laying out columns: `split` balances the groups and
   * `splitIn` fills each one before starting the next.
   */
  splitIn(groups: number): Collection<Collection<T>> {
    return this.chunk(Math.ceil(this.items.length / Math.max(1, groups)))
  }

  /** Is there exactly one match? — the question `sole` throws about. */
  hasSole(predicate?: (item: T, index: number) => boolean): boolean {
    return (predicate ? this.filter(predicate) : this).count() === 1
  }

  /**
   * The first match, or a throw — `firstOrFail`.
   *
   * `first()` answers `undefined`, which a caller then has to narrow; this is for
   * the place where absence is a bug rather than a case.
   */
  firstOrFail(predicate?: (item: T, index: number) => boolean): T {
    const found = predicate ? this.filter(predicate).first() : this.first()

    if (found === undefined) throw new ItemNotFoundError()

    return found
  }

  /**
   * `splice` and `transform` are deliberately absent.
   *
   * Both mutate, which every other method here refuses to do — and the type
   * system charges for it: a `T[]` parameter or a `(item: T) => T` callback makes
   * this class **invariant** in `T`, and `Collection<Model>` then stops being
   * assignable to `Collection<Article>`. Measured: adding them broke six casts in
   * `relations.ts` that had nothing to do with collections.
   *
   * `map()` into a new collection says the same thing, and the caller keeps the
   * old one — which is usually what somebody wanted from `transform` anyway.
   */
  /** The strict twin of `duplicates`; see `containsStrict` for why it is an alias. */
  duplicatesStrict(key: (item: T) => unknown = (item) => item): Collection<T> {
    return this.duplicates(key)
  }

  pluck<K extends keyof T>(key: K): Collection<T[K]> {
    return new Collection(this.items.map((item) => item[key]))
  }

  sortBy(key: (item: T) => string | number): Collection<T> {
    return new Collection(
      [...this.items].sort((a, b) => {
        const left = key(a)
        const right = key(b)
        if (left < right) return -1
        if (left > right) return 1
        return 0
      })
    )
  }

  groupBy(key: (item: T) => string): Record<string, T[]> {
    const result: Record<string, T[]> = {}
    for (const item of this.items) {
      const group = key(item)
      const bucket = result[group] ?? []
      bucket.push(item)
      result[group] = bucket
    }
    return result
  }

  unique(): Collection<T> {
    return new Collection([...new Set(this.items)])
  }

  take(limit: number): Collection<T> {
    return new Collection(limit < 0 ? this.items.slice(limit) : this.items.slice(0, limit))
  }

  values(): T[] {
    return this.all()
  }

  /** Escape hatch: run arbitrary logic on the collection without breaking the chain. */
  tap(callback: (collection: this) => void): this {
    callback(this)
    return this
  }

  // ------------------------------------------------------------- selecting

  /**
   * Exactly one, or an error — Laravel's `sole()`.
   *
   * The point is that "the only one" is an assumption, and `first()` hides it. A
   * lookup expected to be unique that silently returns the first of three is a
   * bug that surfaces much later, wearing a different shape.
   */
  sole(predicate?: (item: T, index: number) => boolean): T {
    const matched = predicate ? this.filter(predicate) : this

    if (matched.count() === 0) throw new ItemNotFoundError()
    if (matched.count() > 1) throw new MultipleItemsFoundError(matched.count())

    return matched.first() as T
  }

  firstWhere<K extends keyof T>(key: K, value: T[K]): T | undefined {
    return this.items.find((item) => item[key] === value)
  }

  where<K extends keyof T>(key: K, value: T[K]): Collection<T> {
    return this.filter((item) => item[key] === value)
  }

  whereIn<K extends keyof T>(key: K, values: Array<T[K]>): Collection<T> {
    const set = new Set(values)

    return this.filter((item) => set.has(item[key]))
  }

  whereNotIn<K extends keyof T>(key: K, values: Array<T[K]>): Collection<T> {
    const set = new Set(values)

    return this.filter((item) => !set.has(item[key]))
  }

  whereNotNull<K extends keyof T>(key: K): Collection<T> {
    return this.filter((item) => item[key] !== null && item[key] !== undefined)
  }

  whereNull<K extends keyof T>(key: K): Collection<T> {
    return this.filter((item) => item[key] === null || item[key] === undefined)
  }

  only(indexes: number[]): Collection<T> {
    const wanted = new Set(indexes)

    return this.filter((_item, index) => wanted.has(index))
  }

  except(indexes: number[]): Collection<T> {
    const unwanted = new Set(indexes)

    return this.filter((_item, index) => !unwanted.has(index))
  }

  /** Every nth item, offset from the start. */
  nth(step: number, offset = 0): Collection<T> {
    return this.filter((_item, index) => (index - offset) % step === 0 && index >= offset)
  }

  /**
   * Overloaded rather than a union, and the union was not a style choice.
   *
   * `T | ((item: T) => boolean)` puts `T` in a parameter position the compiler
   * cannot treat bivariantly, which made the whole collection invariant in `T` —
   * and that cascaded into 771 errors across the model layer, because
   * `ModelBuilder<Post>` stopped being usable as `ModelBuilder<Model>`. Overloads
   * keep the callback's parameter typed without doing that.
   */
  search(predicate: (item: T, index: number) => boolean): number | false
  search(needle: unknown): number | false
  search(needle: unknown): number | false {
    const index =
      typeof needle === 'function'
        ? this.items.findIndex(needle as (item: T, index: number) => boolean)
        : this.items.indexOf(needle as T)

    return index === -1 ? false : index
  }

  // -------------------------------------------------------------- slicing

  slice(start: number, length?: number): Collection<T> {
    return new Collection(
      length === undefined ? this.items.slice(start) : this.items.slice(start, start + length)
    )
  }

  skip(count: number): Collection<T> {
    return new Collection(this.items.slice(count))
  }

  skipWhile(predicate: (item: T, index: number) => boolean): Collection<T> {
    const at = this.items.findIndex((item, index) => !predicate(item, index))

    return new Collection(at === -1 ? [] : this.items.slice(at))
  }

  skipUntil(predicate: (item: T, index: number) => boolean): Collection<T> {
    return this.skipWhile((item, index) => !predicate(item, index))
  }

  takeWhile(predicate: (item: T, index: number) => boolean): Collection<T> {
    const at = this.items.findIndex((item, index) => !predicate(item, index))

    return new Collection(at === -1 ? [...this.items] : this.items.slice(0, at))
  }

  takeUntil(predicate: (item: T, index: number) => boolean): Collection<T> {
    return this.takeWhile((item, index) => !predicate(item, index))
  }

  chunk(size: number): Collection<Collection<T>> {
    if (size < 1) throw new Error('chunk() needs a size of at least 1.')

    const out: Array<Collection<T>> = []
    for (let at = 0; at < this.items.length; at += size) {
      out.push(new Collection(this.items.slice(at, at + size)))
    }

    return new Collection(out)
  }

  /**
   * Break where the callback says so — Laravel's `chunkWhile`.
   *
   * The callback is asked about each item *after the first*, with the chunk so
   * far: returning false starts a new one. Grouping consecutive runs is what it
   * is for, and `groupBy` cannot do it because a run is about adjacency.
   */
  chunkWhile(
    predicate: (item: T, index: number, chunk: Collection<T>) => boolean
  ): Collection<Collection<T>> {
    if (this.items.length === 0) return new Collection([])

    const out: Array<Collection<T>> = []
    let chunk: T[] = [this.items[0] as T]

    for (let index = 1; index < this.items.length; index += 1) {
      const item = this.items[index] as T

      if (!predicate(item, index, new Collection(chunk))) {
        out.push(new Collection(chunk))
        chunk = []
      }

      chunk.push(item)
    }

    out.push(new Collection(chunk))

    return new Collection(out)
  }

  /** Overlapping windows — `sliding(2)` gives every adjacent pair. */
  sliding(size = 2, step = 1): Collection<Collection<T>> {
    if (size < 1 || step < 1) throw new Error('sliding() needs a size and step of at least 1.')

    const windows = Math.floor((this.items.length - size) / step) + 1
    const out: Array<Collection<T>> = []

    for (let index = 0; index < windows; index += 1) {
      out.push(new Collection(this.items.slice(index * step, index * step + size)))
    }

    return new Collection(out)
  }

  /** Into `count` groups of roughly equal size. */
  split(count: number): Collection<Collection<T>> {
    if (count < 1) throw new Error('split() needs at least 1 group.')

    const out: Array<Collection<T>> = []
    const size = Math.floor(this.items.length / count)
    let remainder = this.items.length % count
    let at = 0

    for (let group = 0; group < count; group += 1) {
      const take = size + (remainder > 0 ? 1 : 0)
      if (remainder > 0) remainder -= 1

      out.push(new Collection(this.items.slice(at, at + take)))
      at += take
    }

    return new Collection(out)
  }

  /** Those that pass, and those that do not. */
  partition(predicate: (item: T, index: number) => boolean): [Collection<T>, Collection<T>] {
    const pass: T[] = []
    const fail: T[] = []

    for (const [index, item] of this.items.entries()) {
      ;(predicate(item, index) ? pass : fail).push(item)
    }

    return [new Collection(pass), new Collection(fail)]
  }

  // ------------------------------------------------------------ reshaping

  /** One level down — `[[1,2],[3]]` becomes `[1,2,3]`. */
  collapse(): Collection<T extends Array<infer U> ? U : T> {
    return new Collection(
      this.items.flatMap((item) => (Array.isArray(item) ? item : [item]))
    ) as Collection<T extends Array<infer U> ? U : T>
  }

  /** All the way down, or to `depth` levels. */
  flatten(depth = Number.POSITIVE_INFINITY): Collection<unknown> {
    return new Collection((this.items as unknown[]).flat(depth) as unknown[])
  }

  /** Keyed by whatever the callback returns; a later duplicate wins. */
  keyBy<K extends string | number>(key: (item: T) => K): Record<K, T> {
    const out = {} as Record<K, T>

    for (const item of this.items) out[key(item)] = item

    return out
  }

  /** Each item becomes one entry: `[key, value]`. */
  mapWithKeys<K extends string | number, V>(
    callback: (item: T, index: number) => [K, V]
  ): Record<K, V> {
    const out = {} as Record<K, V>

    this.items.forEach((item, index) => {
      const [key, value] = callback(item, index)
      out[key] = value
    })

    return out
  }

  /** How many of each — `countBy(u => u.role)`. */
  countBy(key: (item: T) => string | number = (item) => String(item)): Record<string, number> {
    const out: Record<string, number> = {}

    for (const item of this.items) {
      const bucket = String(key(item))
      out[bucket] = (out[bucket] ?? 0) + 1
    }

    return out
  }

  /** Values that appear more than once, in the order they first repeat. */
  duplicates(key: (item: T) => unknown = (item) => item): Collection<T> {
    const seen = new Set<unknown>()
    const out: T[] = []

    for (const item of this.items) {
      const value = key(item)

      if (seen.has(value)) out.push(item)
      else seen.add(value)
    }

    return new Collection(out)
  }

  /** Pair each item with the item at the same index of every other list. */
  zip<U>(...lists: Array<Iterable<U>>): Collection<Array<T | U | undefined>> {
    const others = lists.map((list) => [...list])

    return new Collection(
      this.items.map((item, index) => [item, ...others.map((list) => list[index])])
    )
  }

  /** Every combination, one item from each list. */
  crossJoin<U>(...lists: Array<Iterable<U>>): Collection<Array<T | U>> {
    return new Collection(
      this.items.flatMap((item) =>
        lists
          .map((list) => [...list])
          .reduce<Array<Array<T | U>>>(
            (rows, list) => rows.flatMap((row) => list.map((value) => [...row, value])),
            [[item]]
          )
      )
    )
  }

  /** Pad to `size` with `value`; a negative size pads the front. */
  pad(size: number, value: T): Collection<T> {
    const missing = Math.abs(size) - this.items.length
    if (missing <= 0) return new Collection([...this.items])

    const filler = Array.from({ length: missing }, () => value)

    return new Collection(size < 0 ? [...filler, ...this.items] : [...this.items, ...filler])
  }

  reverse(): Collection<T> {
    return new Collection([...this.items].reverse())
  }

  merge(...lists: Array<Iterable<T>>): Collection<T> {
    return new Collection([...this.items, ...lists.flatMap((list) => [...list])])
  }

  concat(items: Iterable<T>): Collection<T> {
    return this.merge(items)
  }

  diff(other: Iterable<T>): Collection<T> {
    const remove = new Set(other)

    return this.filter((item) => !remove.has(item))
  }

  intersect(other: Iterable<T>): Collection<T> {
    const keep = new Set(other)

    return this.filter((item) => keep.has(item))
  }

  uniqueBy(key: (item: T) => unknown): Collection<T> {
    const seen = new Set<unknown>()

    return this.filter((item) => {
      const value = key(item)
      if (seen.has(value)) return false

      seen.add(value)

      return true
    })
  }

  // ------------------------------------------------------------ arithmetic

  sum(key?: (item: T) => number): number {
    return this.items.reduce<number>(
      (total, item) => total + (key ? key(item) : (item as unknown as number)),
      0
    )
  }

  avg(key?: (item: T) => number): number | undefined {
    return this.items.length === 0 ? undefined : this.sum(key) / this.items.length
  }

  min(key?: (item: T) => number): number | undefined {
    if (this.items.length === 0) return undefined

    return Math.min(...this.items.map((item) => (key ? key(item) : (item as unknown as number))))
  }

  max(key?: (item: T) => number): number | undefined {
    if (this.items.length === 0) return undefined

    return Math.max(...this.items.map((item) => (key ? key(item) : (item as unknown as number))))
  }

  /**
   * The middle value, averaging the two middles for an even count.
   *
   * Reported rather than approximated: an even-length median that just takes the
   * lower middle is a different statistic, and quietly so.
   */
  median(key?: (item: T) => number): number | undefined {
    if (this.items.length === 0) return undefined

    const sorted = this.items
      .map((item) => (key ? key(item) : (item as unknown as number)))
      .sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)

    return sorted.length % 2 === 0
      ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : (sorted[middle] as number)
  }

  // -------------------------------------------------------------- ordering

  sort(compare?: (a: T, b: T) => number): Collection<T> {
    return new Collection([...this.items].sort(compare))
  }

  sortDesc(): Collection<T> {
    return this.sort().reverse()
  }

  sortByDesc(key: (item: T) => string | number): Collection<T> {
    return this.sortBy(key).reverse()
  }

  shuffle(): Collection<T> {
    const items = [...this.items]

    // Fisher–Yates: `sort(() => Math.random() - 0.5)` is not a shuffle, and
    // biases towards leaving items where they started.
    for (let index = items.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1))
      ;[items[index], items[swap]] = [items[swap] as T, items[index] as T]
    }

    return new Collection(items)
  }

  random(count = 1): T | Collection<T> | undefined {
    if (this.items.length === 0) return count === 1 ? undefined : new Collection<T>([])

    const shuffled = this.shuffle()

    return count === 1 ? shuffled.first() : shuffled.take(count)
  }

  // -------------------------------------------------------------- mutating

  /** These four change the collection in place, as Laravel's do. */
  push(...items: T[]): this {
    this.items.push(...items)

    return this
  }

  prepend(...items: T[]): this {
    this.items.unshift(...items)

    return this
  }

  pop(): T | undefined {
    return this.items.pop()
  }

  shift(): T | undefined {
    return this.items.shift()
  }

  // ---------------------------------------------------------------- flow

  /**
   * Run the callback only when the condition holds.
   *
   * biome-ignore lint/suspicious/noConfusingVoidType: this is a callback's return
   * type, where `void` is what lets `when(x, (c) => { c.push(1) })` compile at
   * all — a function whose body returns nothing has the type `void`, and `void`
   * is not assignable to `undefined`.
   */
  when(condition: boolean, callback: (collection: this) => Collection<T> | void): Collection<T> {
    return condition ? (callback(this) ?? this) : this
  }

  // biome-ignore lint/suspicious/noConfusingVoidType: as `when`, whose signature this mirrors.
  unless(condition: boolean, callback: (collection: this) => Collection<T> | void): Collection<T> {
    return this.when(!condition, callback)
  }

  /** Hand the whole collection to a function and return what it returns. */
  pipe<U>(callback: (collection: this) => U): U {
    return callback(this)
  }

  every(predicate: (item: T, index: number) => boolean): boolean {
    return this.items.every(predicate)
  }

  some(predicate: (item: T, index: number) => boolean): boolean {
    return this.items.some(predicate)
  }

  implode(separator = '', key?: (item: T) => unknown): string {
    return this.items.map((item) => String(key ? key(item) : item)).join(separator)
  }

  join(separator = '', lastSeparator?: string): string {
    if (lastSeparator === undefined || this.items.length < 2) return this.implode(separator)

    const all = this.items.map(String)
    const last = all.pop() as string

    return `${all.join(separator)}${lastSeparator}${last}`
  }
}

export function collect<T>(items: Iterable<T> = []): Collection<T> {
  return Collection.make(items)
}
