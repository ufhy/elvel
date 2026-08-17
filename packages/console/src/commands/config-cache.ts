import { mkdir } from 'node:fs/promises'
import { Config } from '@elyvel/core'
import { Command } from '../command.ts'

/**
 * `config:cache` — freeze every config file into one JSON document.
 *
 * Read at boot in place of the directory, which saves importing a dozen modules
 * and, more usefully, makes the configuration of a built image a single file you
 * can look at.
 *
 * JSON, not a module. A config file may export a function, a class or a
 * `Date`, and JSON cannot carry any of them — so the command **says which key**
 * rather than writing a cache that silently drops it and leaving somebody to
 * discover at runtime that their callback became `null`. Laravel hits the same
 * wall with `var_export` and reports it the same way.
 */
export class ConfigCacheCommand extends Command {
  static override signature = 'config:cache'

  static override description = 'Cache the configuration files into one JSON document'

  async handle(): Promise<number> {
    // Read from disk rather than from the running application: this process may
    // already be running from a cache, and re-caching that would freeze a stale
    // copy for ever.
    const fresh = await Config.loadFrom(this.app.configPath())
    const items = fresh.all()

    /**
     * A file that carries code is recorded, not cached.
     *
     * `config/app.ts` lists provider *classes* — functions, which JSON cannot
     * carry and which Laravel sidesteps by listing class names as strings.
     * Dropping them silently would produce an application that boots with no
     * providers, so those files are named in the cache and re-imported at boot.
     * The saving is every other file, which is most of them.
     */
    const cacheable: Record<string, unknown> = {}
    const live: string[] = []

    for (const [file, contents] of Object.entries(items)) {
      const problem = findUnserialisable(contents, file)

      if (problem) {
        live.push(file)
        this.comment(`config/${file}.ts holds a ${problem.kind} at [${problem.key}] — read live.`)

        continue
      }

      cacheable[file] = contents
    }

    const path = this.app.basePath('bootstrap', 'cache', 'config.json')

    await mkdir(this.app.basePath('bootstrap', 'cache'), { recursive: true })
    await Bun.write(path, `${JSON.stringify({ config: cacheable, live }, null, 2)}\n`)

    this.output.tag(
      'INFO',
      `Cached ${Object.keys(cacheable).length} config file(s): ${path.replace(`${this.app.basePath()}/`, '')}`
    )

    return 0
  }
}

/** The first key JSON would quietly change or drop. */
function findUnserialisable(value: unknown, key = ''): { key: string; kind: string } | undefined {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return { key, kind: 'function' }
    if (typeof value === 'symbol' || typeof value === 'bigint') {
      return { key, kind: typeof value }
    }

    return undefined
  }

  // A Date survives as a string, which is a change of type rather than a loss —
  // still worth refusing, because the config that read it back would break.
  if (value instanceof Date) return { key, kind: 'Date' }
  if (value instanceof Map || value instanceof Set) return { key, kind: value.constructor.name }

  for (const [child, entry] of Object.entries(value)) {
    const found = findUnserialisable(entry, key === '' ? child : `${key}.${child}`)

    if (found) return found
  }

  return undefined
}
