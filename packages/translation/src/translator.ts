import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Arr } from '@elysian/support'
import { choose } from './selector.ts'

export type Messages = Record<string, unknown>

/**
 * Messages in more than one language — Laravel's `Translator`.
 *
 * A file per locale under `lang/`, read once at boot. `lang/en/validation.ts`
 * becomes the `validation.*` keys, so `__('validation.required')` reads the way
 * it does in Laravel and the message files stay portable between the two.
 *
 * A missing key returns **the key itself** rather than an empty string or a
 * throw. That is deliberate and it is what makes translating incremental: an
 * untranslated page shows `orders.title` — obviously wrong, obviously fixable —
 * where an empty string shows a page that looks finished and says nothing.
 */
export class Translator {
  private readonly messages = new Map<string, Messages>()

  constructor(
    private locale = 'en',
    private readonly fallback = 'en'
  ) {}

  /** Load every `lang/<locale>/<group>.ts` under a directory. */
  async load(directory: string): Promise<this> {
    let locales: string[]

    try {
      locales = await readdir(directory)
    } catch {
      // No lang directory is the ordinary case for an application with one
      // language, not an error.
      return this
    }

    for (const locale of locales) {
      let files: string[]

      try {
        files = await readdir(join(directory, locale))
      } catch {
        continue
      }

      for (const file of files) {
        if (!/\.(ts|js|mts|mjs)$/.test(file) || file.endsWith('.d.ts')) continue

        const group = file.replace(/\.(ts|js|mts|mjs)$/, '')
        const module = (await import(join(directory, locale, file))) as { default?: Messages }

        if (module.default) this.add(locale, group, module.default)
      }
    }

    return this
  }

  /** Add messages directly — for tests, and for a package shipping its own. */
  add(locale: string, group: string, messages: Messages): this {
    const existing = this.messages.get(locale) ?? {}

    this.messages.set(locale, { ...existing, [group]: messages })

    return this
  }

  setLocale(locale: string): this {
    this.locale = locale

    return this
  }

  getLocale(): string {
    return this.locale
  }

  has(key: string, locale?: string): boolean {
    return this.lookup(key, locale ?? this.locale) !== undefined
  }

  /**
   * The message for a key, with `:placeholders` filled in.
   *
   * Falls back to the fallback locale before giving up, so a half-translated
   * locale shows English for what it is missing rather than raw keys.
   */
  get(key: string, replace: Record<string, unknown> = {}, locale?: string): string {
    const line = this.lookup(key, locale ?? this.locale) ?? this.lookup(key, this.fallback) ?? key

    return interpolate(String(line), replace)
  }

  /**
   * Choose a form by count — `choice('orders.count', 3)`.
   *
   * `:count` is filled in automatically, because a message that says "3 orders"
   * needs the number it was chosen by, and passing it twice is the kind of thing
   * everybody forgets once.
   */
  choice(
    key: string,
    count: number,
    replace: Record<string, unknown> = {},
    locale?: string
  ): string {
    const resolved = locale ?? this.locale
    const line = this.lookup(key, resolved) ?? this.lookup(key, this.fallback) ?? key

    return interpolate(choose(String(line), count, resolved), { count, ...replace })
  }

  private lookup(key: string, locale: string): unknown {
    const messages = this.messages.get(locale)

    if (!messages) return undefined

    const value = Arr.get(messages, key)

    return typeof value === 'string' ? value : undefined
  }
}

/**
 * Fill `:name` placeholders, matching case.
 *
 * `:Attribute` becomes `Email` and `:ATTRIBUTE` becomes `EMAIL`, which is how
 * Laravel lets one message serve the start of a sentence and the middle of one
 * without a second key.
 */
export function interpolate(line: string, replace: Record<string, unknown>): string {
  let result = line

  // Longest first: `:name_first` must not be eaten by `:name`.
  for (const key of Object.keys(replace).sort((a, b) => b.length - a.length)) {
    const value = String(replace[key] ?? '')

    result = result
      .replaceAll(`:${key.toUpperCase()}`, value.toUpperCase())
      .replaceAll(`:${key.charAt(0).toUpperCase()}${key.slice(1)}`, capitalise(value))
      .replaceAll(`:${key}`, value)
  }

  return result
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
