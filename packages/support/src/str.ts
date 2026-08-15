/**
 * String helpers. Port of the subset of `Illuminate\Support\Str` that the
 * framework itself needs (stub generation, route listing, view names).
 */

const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
  man: 'men',
  woman: 'women',
  child: 'children',
  tooth: 'teeth',
  foot: 'feet',
  mouse: 'mice',
  goose: 'geese'
}

const UNCOUNTABLE = new Set([
  'equipment',
  'information',
  'rice',
  'money',
  'species',
  'series',
  'fish',
  'sheep',
  'data',
  'news'
])

export const Str = {
  /** `hello world` -> `HelloWorld` */
  studly(value: string): string {
    return Str.words(value)
      .map((word) => Str.ucfirst(word))
      .join('')
  },

  /** `hello world` -> `helloWorld` */
  camel(value: string): string {
    return Str.lcfirst(Str.studly(value))
  },

  /** `HelloWorld` -> `hello_world` */
  snake(value: string, delimiter = '_'): string {
    return Str.words(value)
      .map((word) => word.toLowerCase())
      .join(delimiter)
  },

  /** `HelloWorld` -> `hello-world` */
  kebab(value: string): string {
    return Str.snake(value, '-')
  },

  /** `hello_world` -> `Hello World` */
  headline(value: string): string {
    return Str.words(value)
      .map((word) => Str.ucfirst(word))
      .join(' ')
  },

  title(value: string): string {
    return Str.headline(value)
  },

  slug(value: string, separator = '-'): string {
    return value
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-zA-Z0-9\s_-]+/g, '')
      .trim()
      .replace(/[\s_-]+/g, separator)
      .toLowerCase()
  },

  /** Split an arbitrarily-cased identifier into its word parts. */
  words(value: string): string[] {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s._\-/\\]+/)
      .filter((word) => word.length > 0)
  },

  ucfirst(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1)
  },

  lcfirst(value: string): string {
    return value.charAt(0).toLowerCase() + value.slice(1)
  },

  startsWith(value: string, needles: string | string[]): boolean {
    return Str.wrapNeedles(needles).some((needle) => value.startsWith(needle))
  },

  endsWith(value: string, needles: string | string[]): boolean {
    return Str.wrapNeedles(needles).some((needle) => value.endsWith(needle))
  },

  contains(value: string, needles: string | string[]): boolean {
    return Str.wrapNeedles(needles).some((needle) => value.includes(needle))
  },

  /** Ensure `value` begins with `prefix`, without duplicating it. */
  start(value: string, prefix: string): string {
    return value.startsWith(prefix) ? value : prefix + value
  },

  /** Ensure `value` ends with `suffix`, without duplicating it. */
  finish(value: string, suffix: string): string {
    return value.endsWith(suffix) ? value : value + suffix
  },

  /** Strip `suffix` from the end of `value` if present. */
  chopEnd(value: string, suffix: string): string {
    return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value
  },

  /** Everything before the first occurrence of `search`. */
  before(value: string, search: string): string {
    const index = value.indexOf(search)
    return index === -1 ? value : value.slice(0, index)
  },

  /** Everything after the first occurrence of `search`. */
  after(value: string, search: string): string {
    const index = value.indexOf(search)
    return index === -1 ? value : value.slice(index + search.length)
  },

  /** Everything after the last occurrence of `search`. */
  afterLast(value: string, search: string): string {
    const index = value.lastIndexOf(search)
    return index === -1 ? value : value.slice(index + search.length)
  },

  limit(value: string, limit = 100, end = '...'): string {
    return value.length <= limit ? value : value.slice(0, limit).trimEnd() + end
  },

  padLeft(value: string, length: number, pad = ' '): string {
    return value.padStart(length, pad)
  },

  padRight(value: string, length: number, pad = ' '): string {
    return value.padEnd(length, pad)
  },

  plural(value: string): string {
    const lower = value.toLowerCase()
    if (UNCOUNTABLE.has(lower)) return value

    const irregular = IRREGULAR_PLURALS[lower]
    if (irregular) return Str.matchCase(irregular, value)

    if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`
    if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`
    if (/(f|fe)$/i.test(value)) return `${value.replace(/fe?$/i, '')}ves`
    if (/(o)$/i.test(value)) return `${value}es`

    return `${value}s`
  },

  singular(value: string): string {
    const lower = value.toLowerCase()
    if (UNCOUNTABLE.has(lower)) return value

    for (const [singular, plural] of Object.entries(IRREGULAR_PLURALS)) {
      if (lower === plural) return Str.matchCase(singular, value)
    }

    if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`
    if (/ves$/i.test(value)) return `${value.slice(0, -3)}f`
    if (/(s|x|z|ch|sh)es$/i.test(value)) return value.slice(0, -2)
    if (/s$/i.test(value) && !/ss$/i.test(value)) return value.slice(0, -1)

    return value
  },

  random(length = 16): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const bytes = crypto.getRandomValues(new Uint8Array(length))
    let result = ''
    for (const byte of bytes) result += alphabet[byte % alphabet.length]
    return result
  },

  uuid(): string {
    return crypto.randomUUID()
  },

  /** Replace `{{ key }}` placeholders — the stub engine's substitution. */
  replacePlaceholders(template: string, replacements: Record<string, string>): string {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
      const value = replacements[key]
      return value === undefined ? match : value
    })
  },

  wrapNeedles(needles: string | string[]): string[] {
    return Array.isArray(needles) ? needles : [needles]
  },

  matchCase(value: string, reference: string): string {
    if (reference === reference.toUpperCase()) return value.toUpperCase()
    if (reference.charAt(0) === reference.charAt(0).toUpperCase()) return Str.ucfirst(value)
    return value
  },

  // ----------------------------------------------------------- inspecting

  /** Does it match a pattern with `*` wildcards? Laravel's `Str::is`. */
  is(pattern: string | string[], value: string): boolean {
    return (Array.isArray(pattern) ? pattern : [pattern]).some((one) => {
      if (one === value) return true

      const escaped = one.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

      return new RegExp(`^${escaped}$`).test(value)
    })
  },

  isJson(value: string): boolean {
    try {
      JSON.parse(value)

      return true
    } catch {
      return false
    }
  },

  isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  },

  isUlid(value: string): boolean {
    // Crockford base32, 26 characters, and never I, L, O or U.
    return /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/i.test(value)
  },

  isAscii(value: string): boolean {
    // The control range is the definition of ASCII, so it belongs in the pattern.
    return new RegExp(`^[${String.fromCharCode(0)}-${String.fromCharCode(127)}]*$`).test(value)
  },

  isEmpty(value: string): boolean {
    return value === ''
  },

  wordCount(value: string): number {
    const words = value.trim().split(/\s+/).filter(Boolean)

    return words.length
  },

  // ------------------------------------------------------------- slicing

  /** Everything before the last occurrence. */
  beforeLast(value: string, search: string): string {
    const at = value.lastIndexOf(search)

    return at === -1 ? value : value.slice(0, at)
  },

  /** What sits between the first `from` and the last `to`. */
  between(value: string, from: string, to: string): string {
    if (from === '' || to === '') return value

    return Str.beforeLast(Str.after(value, from), to)
  },

  /** The same, but stopping at the *first* `to`. */
  betweenFirst(value: string, from: string, to: string): string {
    if (from === '' || to === '') return value

    return Str.before(Str.after(value, from), to)
  },

  charAt(value: string, index: number): string | undefined {
    return [...value].at(index)
  },

  /** The first `length` characters, counted by code point. */
  take(value: string, length: number): string {
    const characters = [...value]

    return length < 0 ? characters.slice(length).join('') : characters.slice(0, length).join('')
  },

  /** A window around the first match — Laravel's `excerpt`. */
  excerpt(value: string, phrase: string, radius = 100, omission = '...'): string | undefined {
    const at = value.indexOf(phrase)
    if (at === -1) return undefined

    const start = Math.max(0, at - radius)
    const end = Math.min(value.length, at + phrase.length + radius)

    return (
      (start > 0 ? omission : '') + value.slice(start, end) + (end < value.length ? omission : '')
    )
  },

  // ------------------------------------------------------------ changing

  /** Collapse runs of whitespace, and trim. */
  squish(value: string): string {
    return value.trim().replace(/\s+/g, ' ')
  },

  /** Collapse repeats of one character: `a--b---c` becomes `a-b-c`. */
  deduplicate(value: string, character = ' '): string {
    const escaped = character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    return value.replace(new RegExp(`${escaped}+`, 'g'), character)
  },

  remove(search: string | string[], value: string): string {
    return (Array.isArray(search) ? search : [search]).reduce(
      (carry, one) => carry.split(one).join(''),
      value
    )
  },

  /** Swap several pairs at once, left to right. */
  swap(replacements: Record<string, string>, value: string): string {
    return Object.entries(replacements).reduce(
      (carry, [from, to]) => carry.split(from).join(to),
      value
    )
  },

  /** Replace each `?` with the next value — Laravel's `replaceArray`. */
  replaceArray(search: string, values: string[], value: string): string {
    let index = 0

    return value.split(search).reduce((carry, part, position) => {
      if (position === 0) return part

      const replacement = values[index] ?? search
      index += 1

      return `${carry}${replacement}${part}`
    }, '')
  },

  /** Wrap in a prefix and suffix; one argument wraps on both sides. */
  wrap(value: string, before: string, after = before): string {
    return `${before}${value}${after}`
  },

  /**
   * Hide all but the ends — `mask('4111111111111111', '*', 4, -4)`.
   *
   * For a card number or an address in a log, where the shape has to survive and
   * the value must not.
   */
  mask(value: string, character = '*', start = 0, length?: number): string {
    const characters = [...value]
    const from = start < 0 ? Math.max(0, characters.length + start) : start

    /**
     * A negative length stops that many characters from the end.
     *
     * PHP's `substr` semantics, which Laravel relies on: `mask(card, '*', 4, -4)`
     * hides everything between the first four and the last four. Reading it as
     * `Math.abs(length)` masks four characters and leaves the rest of the number
     * in the log — which is the opposite of what the caller asked for, and looks
     * plausible enough to ship.
     */
    const to =
      length === undefined
        ? characters.length
        : length < 0
          ? Math.max(from, characters.length + length)
          : Math.min(characters.length, from + length)

    return [
      ...characters.slice(0, from),
      ...Array.from({ length: to - from }, () => character),
      ...characters.slice(to)
    ].join('')
  },

  /** Initials from the words: `Ada Lovelace` becomes `AL`. */
  initials(value: string, separator = ''): string {
    return Str.squish(value)
      .split(' ')
      .filter(Boolean)
      .map((word) => [...word][0]?.toUpperCase() ?? '')
      .join(separator)
  },

  /** A ULID: 48 bits of time, then randomness, sortable by creation. */
  ulid(at: number = Date.now()): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let time = ''
    let remaining = at

    for (let index = 0; index < 10; index += 1) {
      time = (alphabet[remaining % 32] as string) + time
      remaining = Math.floor(remaining / 32)
    }

    const random = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => alphabet[byte % 32] as string
    ).join('')

    return time + random
  },

  doesntContain(value: string, needles: string | string[]): boolean {
    return !Str.contains(value, needles)
  },

  doesntStartWith(value: string, needles: string | string[]): boolean {
    return !Str.startsWith(value, needles)
  },

  doesntEndWith(value: string, needles: string | string[]): boolean {
    return !Str.endsWith(value, needles)
  }
}
