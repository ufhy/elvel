import type { ApplicationContract } from '@elvel/contracts'
import { type Dispatcher, Repository } from './repository.ts'
import type { Store } from './store.ts'
import { ArrayStore } from './stores/array.ts'
import { DatabaseStore } from './stores/database.ts'
import { FileStore } from './stores/file.ts'
import { RedisStore } from './stores/redis.ts'

export type StoreConfig = { driver: string } & Record<string, unknown>

/** Builds a store from its configuration — how `extend()` adds a driver. */
export type StoreFactory = (config: StoreConfig, app: ApplicationContract) => Store

/**
 * Resolves and caches stores — `Illuminate\Cache\CacheManager`.
 *
 * A `Repository` is memoised per store name, so `cache()` and
 * `cache().store('redis')` in the same request share one connection and one
 * in-memory map.
 */
export class CacheManager {
  private readonly repositories = new Map<string, Repository>()
  private readonly customDrivers = new Map<string, StoreFactory>()

  constructor(private readonly app: ApplicationContract) {}

  /** The default store, or a named one. */
  store(name?: string): Repository {
    const resolved = name ?? this.defaultStore()
    const cached = this.repositories.get(resolved)
    if (cached) return cached

    const repository = this.resolve(resolved)
    this.repositories.set(resolved, repository)

    return repository
  }

  /** Register a driver of your own, as Laravel's `Cache::extend()` does. */
  extend(driver: string, factory: StoreFactory): this {
    this.customDrivers.set(driver, factory)
    // A store already built on the old driver would otherwise be kept.
    this.repositories.clear()

    return this
  }

  defaultStore(): string {
    return this.app.config.get<string>('cache.default', 'file')
  }

  setDefaultStore(name: string): void {
    this.app.config.set('cache.default', name)
  }

  /** Drop the memoised repositories, e.g. after changing configuration. */
  forgetStores(): void {
    this.repositories.clear()
  }

  private resolve(name: string): Repository {
    const config = this.app.config.get<StoreConfig | undefined>(`cache.stores.${name}`)

    if (!config) {
      throw new Error(`Cache store [${name}] is not configured. Add it to config/cache.ts.`)
    }

    return new Repository(this.build(name, config), {
      events: this.dispatcher(),
      name
    })
  }

  private build(name: string, config: StoreConfig): Store {
    const custom = this.customDrivers.get(config.driver)
    if (custom) return custom(config, this.app)

    // The global prefix keeps two applications apart on a shared server; a store
    // may override it.
    const prefix = String(
      config.prefix ?? this.app.config.get<string>('cache.prefix', 'elvel_cache_')
    )

    switch (config.driver) {
      case 'array':
        return new ArrayStore(prefix)

      case 'file':
        return new FileStore(
          String(config.path ?? this.app.storagePath('framework', 'cache')),
          prefix
        )

      case 'database':
        return new DatabaseStore(this.app.make('db'), {
          connection: config.connection as string | undefined,
          table: config.table as string | undefined,
          lockTable: config.lockTable as string | undefined,
          lockConnection: config.lockConnection as string | undefined,
          prefix
        })

      case 'redis':
        return new RedisStore({
          url: config.url as string | undefined,
          client: config.client as never,
          prefix
        })

      default:
        throw new Error(
          `Cache driver [${config.driver}] for store [${name}] is not supported. Register it with cache().extend().`
        )
    }
  }

  private dispatcher(): Dispatcher | undefined {
    // Optional: the cache has to work in an application with no events package.
    return this.app.bound('events') ? (this.app.make('events' as never) as Dispatcher) : undefined
  }
}
