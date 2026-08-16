import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigRepository } from '@elysian/contracts'
import { Arr } from '@elysian/support'

/**
 * Config repository — the `LoadConfiguration` bootstrapper.
 *
 * Every `config/<name>.ts` file's default export becomes the `<name>` key,
 * so `config/app.ts` exporting `{ name: 'Elysian' }` reads as
 * `config('app.name')`.
 */
export class Config implements ConfigRepository {
  constructor(private items: Record<string, unknown> = {}) {}

  /**
   * Load from a cached JSON file instead of reading the directory.
   *
   * Returns undefined when there is no cache, which is the ordinary path in
   * development. The cache is JSON rather than a module: a config file can
   * export a function or a class, and JSON refusing to carry one is the point —
   * see `config:cache`, which says so rather than writing a file that silently
   * drops it.
   */
  static async loadCached(path: string, directory: string): Promise<Config | undefined> {
    const file = Bun.file(path)

    if (!(await file.exists())) return undefined

    const cached = (await file.json()) as { config: Record<string, unknown>; live?: string[] }

    const config = new Config({ ...cached.config })
    config.cached = true

    /**
     * A file that carries code is re-imported rather than cached.
     *
     * `config/app.ts` lists provider classes, which JSON cannot hold. Reading
     * those few files live is what makes caching the rest possible at all.
     */
    for (const name of cached.live ?? []) {
      const module = (await import(join(directory, `${name}.ts`))) as { default?: unknown }

      if (module.default !== undefined) config.set(name, module.default)
    }

    return config
  }

  /** Was this loaded from a cache file? `config:clear` and `about` ask. */
  cached = false

  /**
   * Build from named loaders rather than from a directory — see
   * `ApplicationBuilder.withConfig`.
   *
   * Awaited one at a time, in the order given, because a config file may read
   * something an earlier one set up and because the failure of one should name
   * itself rather than arriving as an unhandled rejection among several.
   */
  static async loadUsing(loaders: Record<string, () => Promise<{ default?: unknown }>>) {
    const config = new Config()

    for (const [key, load] of Object.entries(loaders)) {
      const module = await load()

      if (module.default === undefined) {
        throw new Error(
          `Config loader "${key}" resolved a module with no default export. Export the config object as default.`
        )
      }

      config.set(key, module.default)
    }

    return config
  }

  static async loadFrom(directory: string): Promise<Config> {
    const config = new Config()

    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return config
    }

    const files = entries
      .filter((entry) => /\.(ts|js|mts|mjs)$/.test(entry) && !entry.endsWith('.d.ts'))
      .sort()

    for (const file of files) {
      const key = file.replace(/\.(ts|js|mts|mjs)$/, '')
      const module = (await import(join(directory, file))) as { default?: unknown }

      if (module.default === undefined) {
        throw new Error(
          `Config file "config/${file}" has no default export. Export the config object as default.`
        )
      }

      config.set(key, module.default)
    }

    return config
  }

  has(key: string): boolean {
    return Arr.has(this.items, key)
  }

  get<T = unknown>(key: string): T
  get<T>(key: string, fallback: T): T
  get<T>(key: string, fallback?: T): T {
    return Arr.get<T>(this.items, key, fallback as T)
  }

  set(key: string, value: unknown): void {
    Arr.set(this.items, key, value)
  }

  all(): Record<string, unknown> {
    return this.items
  }
}
