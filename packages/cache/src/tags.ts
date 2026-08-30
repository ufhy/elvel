import type { Store } from './store.ts'

/**
 * A set of tags, and the namespace they form — `Illuminate\Cache\TagSet`.
 *
 * Each tag holds a random id. The namespace for a write is the ids joined
 * together, so flushing a tag is just giving it a new id: every key written under
 * the old namespace becomes unreachable at once, without scanning or tracking
 * which keys belonged to it. Those entries linger until their own TTL runs out,
 * which is the trade this design makes and the reason tags need no index.
 */
export class TagSet {
  constructor(
    private readonly store: Store,
    readonly names: string[]
  ) {}

  /** Give every tag a new id, orphaning everything written under the old one. */
  async reset(): Promise<void> {
    for (const name of this.names) await this.resetTag(name)
  }

  async resetTag(name: string): Promise<string> {
    const id = crypto.randomUUID().replaceAll('-', '')

    await this.store.forever(this.tagKey(name), id)

    return id
  }

  async flush(): Promise<void> {
    for (const name of this.names) await this.store.forget(this.tagKey(name))
  }

  /**
   * The current namespace. Creates any tag that does not exist yet.
   *
   * One read for the whole set. Laravel asks the store for each tag in turn, and
   * so did this: `tags('a', 'b')` against Redis spent two round trips finding out
   * what the namespace was before it could touch the key it came for.
   *
   * Only the tags that are genuinely missing are created, and only those cost a
   * write.
   */
  async namespace(): Promise<string> {
    if (this.names.length === 0) return ''

    const keys = this.names.map((name) => this.tagKey(name))
    const found = await this.store.many<string>(keys)

    const ids: string[] = []

    for (const [index, name] of this.names.entries()) {
      const existing = found[keys[index] as string]

      ids.push(typeof existing === 'string' ? existing : await this.resetTag(name))
    }

    return ids.join('|')
  }

  async tagId(name: string): Promise<string> {
    const existing = await this.store.get<string>(this.tagKey(name))

    return existing ?? (await this.resetTag(name))
  }

  tagKey(name: string): string {
    return `tag:${name}:key`
  }
}

/**
 * The store a tagged cache writes through: same driver, prefixed keys.
 *
 * Doing it here rather than in the repository keeps every method — including
 * `many`, `increment` and the locks — namespaced without each one remembering to
 * ask.
 */
export class NamespacedStore implements Store {
  constructor(
    private readonly inner: Store,
    private readonly tagSet: TagSet
  ) {}

  get prefix(): string {
    return this.inner.prefix
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.inner.get<T>(await this.itemKey(key))
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    const named = await this.keyer()
    const mapped = new Map<string, string>()

    for (const key of keys) mapped.set(key, named(key))

    const values = await this.inner.many<T>([...mapped.values()])

    const result: Record<string, T | null> = {}
    for (const [key, namespaced] of mapped) result[key] = values[namespaced] ?? null

    return result
  }

  async put(key: string, value: unknown, seconds: number): Promise<boolean> {
    return this.inner.put(await this.itemKey(key), value, seconds)
  }

  async putMany(values: Record<string, unknown>, seconds: number): Promise<boolean> {
    const named = await this.keyer()
    const namespaced: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(values)) {
      namespaced[named(key)] = value
    }

    return this.inner.putMany(namespaced, seconds)
  }

  async add(key: string, value: unknown, seconds: number): Promise<boolean> {
    return this.inner.add(await this.itemKey(key), value, seconds)
  }

  async increment(key: string, value = 1): Promise<number | false> {
    return this.inner.increment(await this.itemKey(key), value)
  }

  async decrement(key: string, value = 1): Promise<number | false> {
    return this.inner.decrement(await this.itemKey(key), value)
  }

  async forever(key: string, value: unknown): Promise<boolean> {
    return this.inner.forever(await this.itemKey(key), value)
  }

  async forget(key: string): Promise<boolean> {
    return this.inner.forget(await this.itemKey(key))
  }

  /** Reached only through the tagged cache's flush, which resets the tags. */
  async flush(): Promise<boolean> {
    await this.tagSet.reset()

    return true
  }

  private async itemKey(key: string): Promise<string> {
    return (await this.keyer())(key)
  }

  /**
   * Resolve the namespace once, then name as many keys as needed from it.
   *
   * `many(keys)` used to call `itemKey` per key, so twenty keys under two tags
   * meant forty reads of the tag ids and twenty SHA-1 hashes before the one
   * `mget` it was actually there for — 1,270µs against Redis for a call whose
   * useful work is two round trips.
   */
  private async keyer(): Promise<(key: string) => string> {
    const namespace = await this.tagSet.namespace()
    const hash = new Bun.CryptoHasher('sha1').update(namespace).digest('hex')

    return (key) => `${hash}:${key}`
  }
}
