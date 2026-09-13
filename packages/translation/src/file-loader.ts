import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Messages, TranslationLoader } from './translator.ts'

/**
 * The default loader: `lang/<locale>/<group>.ts` and `lang/<locale>.json`.
 *
 * The same reading the translator always did, behind the contract — so a
 * database-backed or CMS-backed loader is a peer of this rather than a fork of
 * the translator.
 */
export class FileLoader implements TranslationLoader {
  constructor(private readonly directory: string) {}

  async locales(): Promise<string[]> {
    let entries: string[]

    try {
      entries = await readdir(this.directory)
    } catch {
      // No lang directory is the ordinary case for an application with one
      // language, not an error.
      return []
    }

    return [...new Set(entries.map((entry) => entry.replace(/\.json$/, '')))]
  }

  async groups(locale: string): Promise<Record<string, Messages>> {
    const out: Record<string, Messages> = {}

    let files: string[]

    try {
      files = await readdir(join(this.directory, locale))
    } catch {
      return out
    }

    for (const file of files) {
      if (!/\.(ts|js|mts|mjs)$/.test(file) || file.endsWith('.d.ts')) continue

      const module = (await import(join(this.directory, locale, file))) as { default?: Messages }

      if (module.default) out[file.replace(/\.(ts|js|mts|mjs)$/, '')] = module.default
    }

    return out
  }

  async sentences(locale: string): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.directory, `${locale}.json`), 'utf8')
      ) as Record<string, unknown>

      return Object.fromEntries(
        Object.entries(parsed).filter(([, line]) => typeof line === 'string')
      ) as Record<string, string>
    } catch {
      // A malformed or unreadable file leaves the locale with whatever it had:
      // refusing to boot over one language file is a worse trade than showing
      // the untranslated sentences, which are still readable English.
      return {}
    }
  }
}
