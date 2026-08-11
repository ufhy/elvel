/**
 * Collection — the fluent array wrapper Eloquent will return later.
 *
 * Kept intentionally small for now: only what the framework itself consumes.
 * It grows alongside the packages that need it, not ahead of them.
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
}

export function collect<T>(items: Iterable<T> = []): Collection<T> {
  return Collection.make(items)
}
