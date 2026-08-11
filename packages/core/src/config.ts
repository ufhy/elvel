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
