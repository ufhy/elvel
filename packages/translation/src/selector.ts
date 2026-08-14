/**
 * Choose one form of a message for a count — Laravel's `MessageSelector`.
 *
 * Two syntaxes, both from Laravel because the message files are the thing people
 * copy between projects:
 *
 * - **Ranges**: `{0} none|[1,4] a few|[5,*] many`, tried in order and exact.
 * - **Positions**: `one|many`, chosen by the locale's plural rule.
 *
 * The ranges exist because plural rules cannot express "none" — a language with
 * two forms still wants a different sentence for zero, and `{0}` is how that is
 * said without an `if` at every call site.
 */
export function choose(line: string, count: number, locale: string): string {
  const segments = line.split('|')

  for (const segment of segments) {
    const explicit = extractFromCondition(segment, count)

    if (explicit !== undefined) return explicit.trim()
  }

  const stripped = segments.map((segment) => segment.replace(/^[{[][^\]}]*[}\]]/, '').trim())
  const index = pluralIndex(locale, count)

  return (stripped[index] ?? stripped[0] ?? '').trim()
}

/** `{0} none` and `[5,*] many` — an exact count, or a range. */
function extractFromCondition(segment: string, count: number): string | undefined {
  const match = /^[{[]([^\]}]*)[}\]](.*)/s.exec(segment)

  if (!match) return undefined

  const condition = (match[1] ?? '').trim()
  const value = match[2] ?? ''

  if (!condition.includes(',')) {
    return Number(condition) === count ? value : undefined
  }

  const [from, to] = condition.split(',').map((part) => part.trim())

  if (to === '*') return count >= Number(from) ? value : undefined
  if (from === '*') return count <= Number(to) ? value : undefined

  return count >= Number(from) && count <= Number(to) ? value : undefined
}

/**
 * Which form a locale uses for this count.
 *
 * Deliberately not the full CLDR table: that is a data file of its own and most
 * of it describes languages an application ships one message file for. What is
 * here covers the shapes an English-plus-a-few-locales application actually
 * meets — one form, two forms, and the Slavic three-form rule — and a locale
 * outside it falls back to the two-form rule rather than throwing, because a
 * slightly wrong plural beats a crash in a view.
 */
export function pluralIndex(locale: string, count: number): number {
  const language = locale.toLowerCase().split(/[-_]/)[0] ?? 'en'

  // One form for every count.
  if (['az', 'id', 'ja', 'ko', 'ms', 'my', 'th', 'vi', 'zh'].includes(language)) return 0

  // French counts zero as singular; English does not.
  if (['fr', 'ff', 'hy', 'kab'].includes(language)) return count > 1 ? 1 : 0

  if (['ru', 'uk', 'be', 'sr', 'hr', 'bs'].includes(language)) {
    if (count % 10 === 1 && count % 100 !== 11) return 0
    if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20)) return 1

    return 2
  }

  if (language === 'pl') {
    if (count === 1) return 0
    if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14)) return 1

    return 2
  }

  return count === 1 ? 0 : 1
}
