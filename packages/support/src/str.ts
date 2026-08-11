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
  }
}
