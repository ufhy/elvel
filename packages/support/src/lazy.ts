import { Collection } from './collection.ts'

/** What a lazy collection can be built from. */
export type Source<T> =
  | Iterable<T>
  | AsyncIterable<T>
  | (() => Iterable<T> | AsyncIterable<T> | Promise<Iterable<T> | AsyncIterable<T>>)

/**
 * A collection that is walked, not held.
 *
 * The database already streams — `lazy()` on a model builder walks by key — but
 * it handed back a bare generator, so the first `filter` or `take` meant writing
 * the loop by hand or calling `get()` and materialising the table. This is the
 * operator half: `take(5)` over a million rows reads five.
 *
 * Async throughout, unlike upstream's, because the source here is a database
 * cursor rather than a PHP generator. That costs a `for await` at the end of
 * every chain and buys a chain that works over both.
 */
export class LazyCollection<T> implements AsyncIterable<T> {
  constructor(private readonly source: Source<T>) {}

  static make<T>(source: Source<T> = []): LazyCollection<T> {
    return new LazyCollection(source)
  }

  /** Count up from `from`, for ever unless something downstream stops. */
  static range(from: number, to = Number.POSITIVE_INFINITY): LazyCollection<number> {
    return new LazyCollection(function* counting() {
      for (let value = from; value <= to; value += 1) yield value
    })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    const resolved = typeof this.source === 'function' ? await this.source() : this.source

    if (Symbol.asyncIterator in resolved) yield* resolved as AsyncIterable<T>
    else yield* resolved as Iterable<T>
  }

  // ------------------------------------------------------------------ shaping

  map<U>(callback: (item: T, index: number) => U | Promise<U>): LazyCollection<U> {
    const self = this

    return new LazyCollection(async function* mapping() {
      let index = 0

      for await (const item of self) yield await callback(item, index++)
    })
  }

  flatMap<U>(callback: (item: T, index: number) => Iterable<U>): LazyCollection<U> {
    const self = this

    return new LazyCollection(async function* flattening() {
      let index = 0

      for await (const item of self) yield* callback(item, index++)
    })
  }

  filter(predicate: (item: T, index: number) => boolean | Promise<boolean>): LazyCollection<T> {
    const self = this

    return new LazyCollection(async function* filtering() {
      let index = 0

      for await (const item of self) if (await predicate(item, index++)) yield item
    })
  }

  reject(predicate: (item: T, index: number) => boolean | Promise<boolean>): LazyCollection<T> {
    return this.filter(async (item, index) => !(await predicate(item, index)))
  }

  where<K extends keyof T>(key: K, value: T[K]): LazyCollection<T> {
    return this.filter((item) => item[key] === value)
  }

  whereIn<K extends keyof T>(key: K, values: Array<T[K]>): LazyCollection<T> {
    const set = new Set(values)

    return this.filter((item) => set.has(item[key]))
  }

  whereNotNull(): LazyCollection<NonNullable<T>> {
    return this.filter((item) => item !== null && item !== undefined) as unknown as LazyCollection<
      NonNullable<T>
    >
  }

  pluck<K extends keyof T>(key: K): LazyCollection<T[K]> {
    return this.map((item) => item[key])
  }

  unique(by?: (item: T) => unknown): LazyCollection<T> {
    const self = this

    return new LazyCollection(async function* uniquely() {
      const seen = new Set<unknown>()

      for await (const item of self) {
        const identity = by ? by(item) : item

        if (seen.has(identity)) continue

        seen.add(identity)
        yield item
      }
    })
  }

  // ------------------------------------------------------------------ cutting

  /** The point of the whole class: five of a million rows reads five. */
  take(count: number): LazyCollection<T> {
    const self = this

    return new LazyCollection(async function* taking() {
      if (count <= 0) return

      let taken = 0

      for await (const item of self) {
        yield item

        if (++taken >= count) return
      }
    })
  }

  takeWhile(predicate: (item: T, index: number) => boolean): LazyCollection<T> {
    const self = this

    return new LazyCollection(async function* taking() {
      let index = 0

      for await (const item of self) {
        if (!predicate(item, index++)) return

        yield item
      }
    })
  }

  takeUntil(predicate: (item: T, index: number) => boolean): LazyCollection<T> {
    return this.takeWhile((item, index) => !predicate(item, index))
  }

  /**
   * Stop at a deadline rather than a count.
   *
   * What a scheduled command wants: work through as much as fits in the window
   * it was given and leave the rest for the next run, instead of overrunning
   * into the run after it.
   */
  takeUntilTimeout(deadline: Date | number): LazyCollection<T> {
    const at = deadline instanceof Date ? deadline.getTime() : deadline
    const self = this

    return new LazyCollection(async function* taking() {
      for await (const item of self) {
        if (Date.now() >= at) return

        yield item
      }
    })
  }

  skip(count: number): LazyCollection<T> {
    const self = this

    return new LazyCollection(async function* skipping() {
      let skipped = 0

      for await (const item of self) {
        if (skipped++ < count) continue

        yield item
      }
    })
  }

  skipWhile(predicate: (item: T, index: number) => boolean): LazyCollection<T> {
    const self = this

    return new LazyCollection(async function* skipping() {
      let index = 0
      let skipping_ = true

      for await (const item of self) {
        if (skipping_ && predicate(item, index++)) continue

        skipping_ = false
        yield item
      }
    })
  }

  skipUntil(predicate: (item: T, index: number) => boolean): LazyCollection<T> {
    return this.skipWhile((item, index) => !predicate(item, index))
  }

  /** Fixed-size batches, each one a materialised collection. */
  chunk(size: number): LazyCollection<Collection<T>> {
    const self = this

    return new LazyCollection(async function* chunking() {
      let batch: T[] = []

      for await (const item of self) {
        batch.push(item)

        if (batch.length < size) continue

        yield new Collection(batch)
        batch = []
      }

      if (batch.length > 0) yield new Collection(batch)
    })
  }

  // ----------------------------------------------------------------- watching

  /** Look at each item as it goes past, without holding any of them. */
  tapEach(callback: (item: T, index: number) => unknown): LazyCollection<T> {
    const self = this

    return new LazyCollection(async function* tapping() {
      let index = 0

      for await (const item of self) {
        callback(item, index++)
        yield item
      }
    })
  }

  /**
   * Keep what has been walked, so a second pass does not query again.
   *
   * The one place a lazy collection holds memory on purpose, and it is opt-in
   * because that is the trade it makes: a chain walked twice either costs the
   * query twice or costs the rows once.
   */
  remember(): LazyCollection<T> {
    const self = this
    const held: T[] = []
    let iterator: AsyncIterator<T> | undefined
    let done = false

    return new LazyCollection(async function* remembering() {
      yield* held

      if (done) return

      iterator ??= self[Symbol.asyncIterator]()

      while (true) {
        const next = await iterator.next()

        if (next.done === true) {
          done = true

          return
        }

        held.push(next.value)
        yield next.value
      }
    })
  }

  // -------------------------------------------------------------- terminating

  async each(callback: (item: T, index: number) => unknown): Promise<this> {
    let index = 0

    for await (const item of this) {
      if ((await callback(item, index++)) === false) break
    }

    return this
  }

  async first(predicate?: (item: T) => boolean): Promise<T | undefined> {
    for await (const item of this) {
      if (predicate === undefined || predicate(item)) return item
    }

    return undefined
  }

  async firstWhere<K extends keyof T>(key: K, value: T[K]): Promise<T | undefined> {
    return this.first((item) => item[key] === value)
  }

  async contains(predicate: (item: T) => boolean): Promise<boolean> {
    return (await this.first(predicate)) !== undefined
  }

  async reduce<U>(callback: (carry: U, item: T, index: number) => U, initial: U): Promise<U> {
    let carry = initial
    let index = 0

    for await (const item of this) carry = callback(carry, item, index++)

    return carry
  }

  async count(): Promise<number> {
    return this.reduce((total) => total + 1, 0)
  }

  async sum(by?: (item: T) => number): Promise<number> {
    return this.reduce((total, item) => total + (by ? by(item) : (item as unknown as number)), 0)
  }

  async min(by?: (item: T) => number): Promise<number | undefined> {
    return this.extreme(by, (left, right) => left < right)
  }

  async max(by?: (item: T) => number): Promise<number | undefined> {
    return this.extreme(by, (left, right) => left > right)
  }

  async isEmpty(): Promise<boolean> {
    return (await this.first()) === undefined
  }

  /** Walk it all and hold the result — the end of a chain that has narrowed. */
  async all(): Promise<T[]> {
    const items: T[] = []

    for await (const item of this) items.push(item)

    return items
  }

  async collect(): Promise<Collection<T>> {
    return new Collection(await this.all())
  }

  private async extreme(
    by: ((item: T) => number) | undefined,
    wins: (left: number, right: number) => boolean
  ): Promise<number | undefined> {
    let best: number | undefined

    for await (const item of this) {
      const value = by ? by(item) : (item as unknown as number)

      if (best === undefined || wins(value, best)) best = value
    }

    return best
  }
}

/** `lazy(rows)` reads the way `collect(rows)` does. */
export function lazy<T>(source: Source<T> = []): LazyCollection<T> {
  return LazyCollection.make(source)
}
