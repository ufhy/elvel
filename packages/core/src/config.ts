import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigRepository } from '@elvel/contracts'
import { Arr } from '@elvel/support'

/**
 * Config repository — the `LoadConfiguration` bootstrapper.
 *
 * Every `config/<name>.ts` file's default export becomes the `<name>` key,
 * so `config/app.ts` exporting `{ name: 'Elvel' }` reads as
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
      /**
       * A loader that cannot find its file says which config file, and how to
       * get it back.
       *
       * Bun's own message is `Cannot find module '../config/mail.ts' from
       * '/app/bootstrap/app.ts'`, which names a path and a bundler concern and
       * nothing about configuration — and this is now the ordinary way to break
       * a boot, since a scaffolded application ships only the config files its
       * packages need and `config:publish` is how the rest arrive. Somebody who
       * deletes one, or names one before publishing it, should not have to
       * recognise a module-resolution error as a missing setting.
       */
      const module = await load().catch((problem: unknown) => {
        const reason = problem instanceof Error ? problem.message : String(problem)

        if (!/cannot find module/i.test(reason)) throw problem

        throw new Error(
          `bootstrap/app.ts names config/${key}.ts, which is not there. ` +
            `Publish it with \`elvel config:publish ${key}\`, or remove the \`${key}:\` line from withConfig.`,
          { cause: problem }
        )
      })

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

  /**
   * Several keys at once, each with its own default.
   *
   * The argument is the defaults, so the answer is typed from it: a provider
   * reads five settings in one call and gets an object, not five `get` lines.
   */
  getMany<T extends Record<string, unknown>>(keys: T): T {
    const out = {} as Record<string, unknown>

    for (const [key, fallback] of Object.entries(keys)) {
      out[key] = Arr.get(this.items, key, fallback)
    }

    return out as T
  }

  /**
   * The checked readers.
   *
   * `get<number>('queue.retryAfter')` is a **cast**: it types as `number` and
   * returns the string `"90"` that `process.env` actually held, and keeps typing
   * as `number` all the way to the arithmetic that produces `"901"`. These read
   * the value and refuse it if it is the wrong shape.
   *
   * A numeric string is accepted and converted, because that is what an env var
   * is and refusing it would make the readers unusable in the one place they are
   * needed. A non-numeric string is an error naming the key.
   */
  string(key: string, fallback?: string): string {
    const value = this.get<unknown>(key, fallback)

    if (typeof value === 'string') return value

    throw new ConfigTypeError(key, 'a string', value)
  }

  integer(key: string, fallback?: number): number {
    const value = Config.numberAt(this, key, fallback)

    if (Number.isInteger(value)) return value

    throw new ConfigTypeError(key, 'an integer', this.get<unknown>(key, fallback))
  }

  float(key: string, fallback?: number): number {
    return Config.numberAt(this, key, fallback)
  }

  /**
   * `'true'`, `'1'`, `'on'` and `'yes'` are true; their opposites are false.
   *
   * The string forms are here because an env var has no other way to say it,
   * and because `Boolean('false')` is `true` — the bug this exists to stop.
   */
  boolean(key: string, fallback?: boolean): boolean {
    const value = this.get<unknown>(key, fallback)

    if (typeof value === 'boolean') return value

    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase()

      if (['true', '1', 'on', 'yes'].includes(lowered)) return true
      if (['false', '0', 'off', 'no', ''].includes(lowered)) return false
    }

    throw new ConfigTypeError(key, 'a boolean', value)
  }

  array<T = unknown>(key: string, fallback?: T[]): T[] {
    const value = this.get<unknown>(key, fallback)

    if (Array.isArray(value)) return value as T[]

    throw new ConfigTypeError(key, 'an array', value)
  }

  /**
   * Append to a configured array — how a package adds a path or a middleware to
   * a list an application already declared, without reading, spreading and
   * setting it back.
   *
   * A missing key becomes the array, which is what makes the call safe before
   * anybody has declared one.
   */
  push(key: string, ...values: unknown[]): void {
    this.set(key, [...this.array<unknown>(key, []), ...values])
  }

  prepend(key: string, ...values: unknown[]): void {
    this.set(key, [...values, ...this.array<unknown>(key, [])])
  }

  private static numberAt(config: Config, key: string, fallback?: number): number {
    const value = config.get<unknown>(key, fallback)

    if (typeof value === 'number' && Number.isFinite(value)) return value

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)

      if (Number.isFinite(parsed)) return parsed
    }

    throw new ConfigTypeError(key, 'a number', value)
  }
}

/** Names the key and what was there, because neither is obvious from a stack. */
export class ConfigTypeError extends Error {
  constructor(
    readonly key: string,
    expected: string,
    readonly actual: unknown
  ) {
    super(
      `config('${key}') should be ${expected}, and it is ${describe(actual)}. ` +
        'An env var is always a string — cast it in the config file, or use the ' +
        'reader that converts.'
    )
    this.name = 'ConfigTypeError'
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'not set'
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`
  if (Array.isArray(value)) return `an array of ${value.length}`

  return `a ${typeof value}`
}
