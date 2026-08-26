/**
 * String helpers — `Illuminate\Support\Str`.
 *
 * This was once "the subset the framework itself needs", and the scope changed
 * deliberately: an application reaching for `replaceFirst` or `padBoth` and not
 * finding it writes the four lines every project writes, and the fifth project
 * gets an edge case wrong.
 *
 * Still absent, each for a reason rather than by oversight: `markdown` and
 * `inlineMarkdown` need a parser this package will not depend on; `apa` encodes
 * one style guide's title-case rules; `transliterate` and `ascii` need a Unicode
 * table; and `createUuidsUsing` with the `freeze*` family is a testing seam that
 * belongs with a design for deterministic ids rather than here.
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

  /**
   * A random string, drawn evenly.
   *
   * The obvious `byte % alphabet.length` is *not* even. 256 does not divide by
   * 62: bytes 0–7 wrap round to a fifth chance at 'a'–'h', so those eight letters
   * turn up 5 times in 256 where the other fifty-four turn up 4. It sounds
   * academic, and it is worth fixing anyway, because this is what mints session
   * identifiers and CSRF tokens — the two strings in the framework that an
   * attacker most wants to guess.
   *
   * So: reject the bytes that would wrap. 256 - (256 % 62) = 248, and anything
   * at or above it is thrown away and redrawn. Roughly 3% of bytes are
   * discarded, which is why the loop asks for more than it needs and comes back
   * for another handful if it runs short.
   */
  random(length = 16): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const ceiling = 256 - (256 % alphabet.length)

    let result = ''

    while (result.length < length) {
      // A tenth over, so the usual case finishes in one pass.
      const bytes = crypto.getRandomValues(
        new Uint8Array(Math.ceil((length - result.length) * 1.1) + 1)
      )

      for (const byte of bytes) {
        if (byte >= ceiling) continue
        result += alphabet[byte % alphabet.length]
        if (result.length === length) break
      }
    }

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
  },

  // --------------------------------------------------------------- replacing

  /** `replaceFirst('a', 'b', 'banana')` → `'bbnana'`. */
  replaceFirst(search: string, replace: string, subject: string): string {
    if (search === '') return subject

    const at = subject.indexOf(search)

    return at === -1 ? subject : subject.slice(0, at) + replace + subject.slice(at + search.length)
  },

  /** The same from the other end — the one to reach for on a filename. */
  replaceLast(search: string, replace: string, subject: string): string {
    if (search === '') return subject

    const at = subject.lastIndexOf(search)

    return at === -1 ? subject : subject.slice(0, at) + replace + subject.slice(at + search.length)
  },

  /** Replace only where the subject *starts* with it. */
  replaceStart(search: string, replace: string, subject: string): string {
    return search !== '' && subject.startsWith(search)
      ? replace + subject.slice(search.length)
      : subject
  },

  replaceEnd(search: string, replace: string, subject: string): string {
    return search !== '' && subject.endsWith(search)
      ? subject.slice(0, -search.length) + replace
      : subject
  },

  /** `replaceMatches(/\d+/g, 'n', 'a1b22')` → `'anbn'`. */
  replaceMatches(
    pattern: RegExp,
    replace: string | ((match: string) => string),
    subject: string
  ): string {
    return typeof replace === 'string'
      ? subject.replace(pattern, replace)
      : subject.replace(pattern, (match) => replace(match))
  },

  // ----------------------------------------------------------------- padding

  /**
   * `padBoth('7', 5, '0')` → `'00700'`.
   *
   * The odd character goes on the **right**, which is what PHP's `str_pad` does
   * and therefore what a test ported from Laravel expects.
   */
  padBoth(value: string, length: number, pad = ' '): string {
    const missing = length - value.length

    if (missing <= 0 || pad === '') return value

    const left = Math.floor(missing / 2)
    const right = missing - left

    return (
      pad.repeat(Math.ceil(left / pad.length)).slice(0, left) +
      value +
      pad.repeat(Math.ceil(right / pad.length)).slice(0, right)
    )
  },

  // -------------------------------------------------------------------- case

  upper(value: string): string {
    return value.toUpperCase()
  },

  lower(value: string): string {
    return value.toLowerCase()
  },

  /** Every word's first letter, as `ucwords` does. */
  ucwords(value: string, delimiters = ' \t\r\n\f\v'): string {
    const set = new Set(delimiters.split(''))
    let capitalise = true

    return [...value]
      .map((character) => {
        if (set.has(character)) {
          capitalise = true

          return character
        }

        const answer = capitalise ? character.toUpperCase() : character

        capitalise = false

        return answer
      })
      .join('')
  },

  /** `ucsplit('FooBar')` → `['Foo', 'Bar']`. */
  ucsplit(value: string): string[] {
    return value.split(/(?=\p{Lu})/u).filter((part) => part !== '')
  },

  /** Laravel's other name for `studly`, so an example copies across. */
  pascal(value: string): string {
    return Str.studly(value)
  },

  /** `pluralStudly('UserGroup')` → `'UserGroups'`: only the last word changes. */
  pluralStudly(value: string): string {
    const parts = Str.ucsplit(value)
    const last = parts.pop() ?? ''

    return parts.join('') + Str.plural(last)
  },

  // -------------------------------------------------------------- inspecting

  /** `containsAll('the quick fox', ['quick', 'fox'])` → true. */
  containsAll(haystack: string, needles: string[]): boolean {
    return needles.every((needle) => haystack.includes(needle))
  },

  /** Does the whole string match any of these? */
  isMatch(value: string, pattern: RegExp | RegExp[]): boolean {
    return (Array.isArray(pattern) ? pattern : [pattern]).some((one) => one.test(value))
  },

  /** Every match, or an empty array — never `null`, which `String.match` answers. */
  matchAll(value: string, pattern: RegExp): string[] {
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)

    return [...value.matchAll(global)].map((match) => match[1] ?? match[0])
  },

  /** Parseable, and with a scheme — the part that decides whether it is a URL. */
  isUrl(value: string): boolean {
    try {
      return new URL(value).protocol !== ''
    } catch {
      return false
    }
  },

  /** Every digit, and nothing else: `'a1b2'` → `'12'`. */
  numbers(value: string): string {
    return value.replace(/\D/g, '')
  },

  /** How many times a substring occurs, with no regex to escape. */
  substrCount(haystack: string, needle: string): number {
    if (needle === '') return 0

    let count = 0
    let at = haystack.indexOf(needle)

    while (at !== -1) {
      count += 1
      at = haystack.indexOf(needle, at + needle.length)
    }

    return count
  },

  // ---------------------------------------------------------------- reshaping

  reverse(value: string): string {
    return [...value].reverse().join('')
  },

  repeat(value: string, times: number): string {
    return times > 0 ? value.repeat(times) : ''
  },

  /** The twin of the `chopEnd` already here. */
  chopStart(value: string, needles: string | string[]): string {
    for (const needle of Array.isArray(needles) ? needles : [needles]) {
      if (needle !== '' && value.startsWith(needle)) return value.slice(needle.length)
    }

    return value
  },

  /** `unwrap('"quoted"', '"')` → `'quoted'` — undoing what `wrap` did. */
  unwrap(value: string, before: string, after = before): string {
    let answer = value

    if (before !== '' && answer.startsWith(before)) answer = answer.slice(before.length)
    if (after !== '' && answer.endsWith(after)) answer = answer.slice(0, -after.length)

    return answer
  },

  /** Splice by index rather than by search — `substrReplace`. */
  substrReplace(value: string, replace: string, offset = 0, length?: number): string {
    const span = length ?? value.length
    const start = offset < 0 ? Math.max(0, value.length + offset) : Math.min(offset, value.length)
    const end =
      span < 0 ? Math.max(start, value.length + span) : Math.min(start + span, value.length)

    return value.slice(0, start) + replace + value.slice(end)
  },

  /**
   * Break long lines at a width — `wordWrap`.
   *
   * A word longer than the width is left whole unless `cut`, because splitting a
   * URL in half is usually worse than one long line.
   */
  wordWrap(value: string, width = 75, brk = '\n', cut = false): string {
    const lines: string[] = []

    for (const paragraph of value.split('\n')) {
      let line = ''

      for (const word of paragraph.split(' ')) {
        if (line === '') line = word
        else if (`${line} ${word}`.length <= width) line = `${line} ${word}`
        else {
          lines.push(line)
          line = word
        }

        while (cut && line.length > width) {
          lines.push(line.slice(0, width))
          line = line.slice(width)
        }
      }

      lines.push(line)
    }

    return lines.join(brk)
  },

  // ------------------------------------------------------------------ base64

  toBase64(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64')
  },

  fromBase64(value: string): string {
    return Buffer.from(value, 'base64').toString('utf8')
  },

  /** `ltrim`/`rtrim` over a set of characters, which `String.trim` cannot take. */
  ltrim(value: string, characters = ' \n\r\t\v\0'): string {
    let at = 0

    while (at < value.length && characters.includes(value[at] as string)) at += 1

    return value.slice(at)
  },

  rtrim(value: string, characters = ' \n\r\t\v\0'): string {
    let end = value.length

    while (end > 0 && characters.includes(value[end - 1] as string)) end -= 1

    return value.slice(0, end)
  },

  /**
   * A random password from the classes a policy usually asks for.
   *
   * `crypto.getRandomValues`, not `Math.random`: this is a credential, and the
   * difference between the two is whether somebody can predict it.
   */
  password(length = 32, letters = true, digits = true, symbols = true): string {
    const pools: string[] = []

    if (letters) pools.push('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')
    if (digits) pools.push('0123456789')
    if (symbols) pools.push('~!#$%^&*()-_.,<>?/[]{}:;|')

    const alphabet = pools.join('')

    if (alphabet === '') return ''

    const bytes = new Uint32Array(length)

    crypto.getRandomValues(bytes)

    return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')
  }
}
