import { join } from 'node:path'

/**
 * Environment loading — the `LoadEnvironmentVariables` bootstrapper.
 *
 * Bun already loads `.env` from the current working directory, but the
 * application root is not always the cwd (an `elvel` run from a subfolder,
 * a test runner, a compiled binary). So we load explicitly from the app root
 * and never overwrite a variable the real environment already set.
 */

const TRUE_VALUES = new Set(['true', '(true)', 'on', 'yes'])
const FALSE_VALUES = new Set(['false', '(false)', 'off', 'no'])
const NULL_VALUES = new Set(['null', '(null)', 'nil', ''])

export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const separator = withoutExport.indexOf('=')
    if (separator === -1) continue

    const key = withoutExport.slice(0, separator).trim()
    if (key === '') continue

    let value = withoutExport.slice(separator + 1).trim()

    const quote = value.charAt(0)
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    } else {
      // Unquoted values may carry a trailing comment.
      const comment = value.indexOf(' #')
      if (comment !== -1) value = value.slice(0, comment).trim()
    }

    result[key] = value
  }

  return result
}

/**
 * biome-ignore lint/complexity/noStaticOnlyClass: `Env.get('APP_KEY')` is the name
 * this reads under in Laravel, and the class is the namespace that gives it. Loose
 * functions would put `get` and `bool` into every importing module's scope, where
 * they say nothing about what they read.
 */
export class Env {
  /**
   * Merge `.env` (and `.env.<environment>` when present) into `process.env`.
   * Existing values win — a real environment variable always beats a file.
   */
  static async load(basePath: string, environment?: string): Promise<void> {
    // Most specific first: values are never overwritten once set, so
    // `.env.production` must be read before `.env` to be able to win.
    const files = environment ? [`.env.${environment}`, '.env'] : ['.env']

    for (const file of files) {
      const handle = Bun.file(join(basePath, file))
      if (!(await handle.exists())) continue

      for (const [key, value] of Object.entries(parseEnvFile(await handle.text()))) {
        if (process.env[key] === undefined) process.env[key] = value
      }
    }
  }

  /** Read an env var, casting the string forms Laravel casts. */
  static get<T = string | boolean | number | null>(key: string, fallback?: T): T {
    const raw = process.env[key]
    if (raw === undefined) return fallback as T

    const lowered = raw.toLowerCase()
    if (TRUE_VALUES.has(lowered)) return true as T
    if (FALSE_VALUES.has(lowered)) return false as T
    if (NULL_VALUES.has(lowered)) return (raw === '' ? (fallback ?? null) : null) as T

    return raw as T
  }

  static string(key: string, fallback = ''): string {
    const value = Env.get<unknown>(key, fallback)
    return value === null || value === undefined ? fallback : String(value)
  }

  static number(key: string, fallback: number): number {
    const value = process.env[key]
    if (value === undefined || value === '') return fallback
    const parsed = Number(value)
    return Number.isNaN(parsed) ? fallback : parsed
  }

  static boolean(key: string, fallback: boolean): boolean {
    const value = Env.get<unknown>(key, fallback)
    return typeof value === 'boolean' ? value : fallback
  }
}

/** Laravel's `env()` helper. Use it in `config/*` files only. */
export function env<T = string | boolean | number | null>(key: string, fallback?: T): T {
  return Env.get<T>(key, fallback)
}
