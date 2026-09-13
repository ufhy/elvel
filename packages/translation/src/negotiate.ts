/**
 * The best of the locales we have, according to what the client asked for.
 *
 * `Accept-Language: id-ID,id;q=0.9,en;q=0.8` is a ranked list, and the ranking
 * is the point — a client that would rather have Indonesian but will take
 * English says so, and answering in English when Indonesian is available makes
 * the header pointless.
 *
 * A tag matches a locale we have exactly (`id` → `id`), by its base language
 * (`id-ID` → `id`), or by a region we do have when the tag is bare (`id` →
 * `id-ID`, when that is all there is). Nothing matching answers `undefined`,
 * which the caller reads as "keep the default".
 */
export function preferredLocale(header: string | null, available: string[]): string | undefined {
  if (header === null || header.trim() === '' || available.length === 0) return undefined

  const lowered = new Map(available.map((locale) => [locale.toLowerCase(), locale]))

  for (const tag of ranked(header)) {
    if (tag === '*') return available[0]

    const exact = lowered.get(tag)

    if (exact !== undefined) return exact

    const base = lowered.get(tag.split('-')[0] as string)

    if (base !== undefined) return base

    // `id` asked for, `id-ID` is what we have.
    for (const [key, locale] of lowered) {
      if (key.startsWith(`${tag}-`)) return locale
    }
  }

  return undefined
}

/** The header's tags, best first. A malformed `q` sorts last rather than throwing. */
function ranked(header: string): string[] {
  return header
    .split(',')
    .map((entry) => {
      const [tag, ...rest] = entry.trim().split(';')
      const quality = rest
        .map((part) => part.trim())
        .find((part) => part.startsWith('q='))
        ?.slice(2)

      const weight = quality === undefined ? 1 : Number(quality)

      return {
        tag: (tag ?? '').trim().toLowerCase(),
        weight: Number.isFinite(weight) ? weight : 0
      }
    })
    .filter((entry) => entry.tag !== '' && entry.weight > 0)
    .sort((left, right) => right.weight - left.weight)
    .map((entry) => entry.tag)
}
