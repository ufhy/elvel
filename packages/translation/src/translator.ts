import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Arr } from '@elvel/support'
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

  /**
   * Whole-sentence translations, keyed by the sentence itself.
   *
   * Laravel's JSON translations, and the reason they exist is worth stating:
   * `__('orders.empty_state_heading')` needs a key invented for every string,
   * and inventing keys is what stops people translating anything. `__('You have
   * no orders yet.')` reads in the source, works untranslated, and is looked up
   * here — `lang/id.json` supplies the Indonesian.
   *
   * Kept apart from the group messages, and consulted first, exactly as Laravel
   * does: a sentence is not a dotted key and the two never collide.
   */
  private readonly sentences = new Map<string, Record<string, string>>()

  /** Called with a key nothing translated. See `whenMissing`. */
  private missing: ((key: string, locale: string) => string | undefined) | undefined

  constructor(
    private locale = 'en',
    private fallback = 'en'
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

    for (const entry of locales) {
      /**
       * `lang/id.json` is a locale's sentences; `lang/id/` is its groups.
       *
       * Both shapes exist in the same directory, as they do in Laravel, so the
       * entries that are files are read here and the rest are read as
       * directories below.
       */
      if (entry.endsWith('.json')) {
        await this.loadSentences(join(directory, entry), entry.replace(/\.json$/, ''))

        continue
      }

      const locale = entry
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

  /** Read one `lang/<locale>.json` of whole-sentence translations. */
  private async loadSentences(path: string, locale: string): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

      const lines: Record<string, string> = { ...this.sentences.get(locale) }

      for (const [sentence, translation] of Object.entries(parsed)) {
        if (typeof translation === 'string') lines[sentence] = translation
      }

      this.sentences.set(locale, lines)
    } catch {
      // A malformed or unreadable file leaves the locale with whatever it had.
      // Refusing to boot over one language file would be a worse trade than
      // showing the untranslated sentences, which are still readable English.
    }
  }

  /** Add whole-sentence translations directly — the JSON file, in code. */
  addSentences(locale: string, lines: Record<string, string>): this {
    this.sentences.set(locale, { ...this.sentences.get(locale), ...lines })

    return this
  }

  /**
   * Called with any key nothing translated, in any locale.
   *
   * Return a string to use it, or nothing to keep the default behaviour of
   * showing the key. What this is actually for is finding the gaps: log them,
   * count them, or fail a test run that introduced one — a missing translation
   * is invisible in a language nobody on the team reads.
   */
  whenMissing(handler: (key: string, locale: string) => string | undefined): this {
    this.missing = handler

    return this
  }

  setFallback(locale: string): this {
    this.fallback = locale

    return this
  }

  getFallback(): string {
    return this.fallback
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

  /** Is this key translated in this locale, ignoring the fallback? */
  hasForLocale(key: string, locale?: string): boolean {
    const resolved = locale ?? this.locale

    return this.sentence(key, resolved) !== undefined || this.lookup(key, resolved) !== undefined
  }

  /** Is this key translated at all — in this locale or the fallback? */
  has(key: string, locale?: string): boolean {
    return this.hasForLocale(key, locale) || this.hasForLocale(key, this.fallback)
  }

  /**
   * The message for a key, with `:placeholders` filled in.
   *
   * Falls back to the fallback locale before giving up, so a half-translated
   * locale shows English for what it is missing rather than raw keys.
   */
  get(key: string, replace: Record<string, unknown> = {}, locale?: string): string {
    const resolved = locale ?? this.locale

    // Sentences first, then dotted keys, then the fallback locale in the same
    // order. A sentence is not a dotted key, so nothing here can collide.
    const line =
      this.sentence(key, resolved) ??
      this.lookup(key, resolved) ??
      this.sentence(key, this.fallback) ??
      this.lookup(key, this.fallback) ??
      this.missing?.(key, resolved) ??
      key

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
    const line =
      this.sentence(key, resolved) ??
      this.lookup(key, resolved) ??
      this.sentence(key, this.fallback) ??
      this.lookup(key, this.fallback) ??
      key

    return interpolate(choose(String(line), count, resolved), { count, ...replace })
  }

  private sentence(key: string, locale: string): string | undefined {
    return this.sentences.get(locale)?.[key]
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
