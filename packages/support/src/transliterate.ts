/**
 * Latin letters for the scripts where that means something.
 *
 * Cyrillic and Greek have accepted romanisations, so `Привет` can honestly
 * become `privet`. CJK and Arabic do not — a character is a word, not a sound —
 * so they are left alone and `slug()` keeps them rather than deleting them.
 *
 * Combining marks are handled by `NFKD` before this table is consulted, which is
 * what turns `é` into `e` without an entry for every accented letter.
 */

const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  // Ukrainian, Belarusian, Serbian
  і: 'i',
  ї: 'yi',
  є: 'ye',
  ґ: 'g',
  ў: 'u',
  ђ: 'dj',
  ј: 'j',
  љ: 'lj',
  њ: 'nj',
  ћ: 'c',
  џ: 'dz'
}

const GREEK: Record<string, string> = {
  α: 'a',
  β: 'v',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'i',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'n',
  ξ: 'x',
  ο: 'o',
  π: 'p',
  ρ: 'r',
  σ: 's',
  ς: 's',
  τ: 't',
  υ: 'y',
  φ: 'f',
  χ: 'ch',
  ψ: 'ps',
  ω: 'o'
}

/** Letters `NFKD` cannot decompose, because they are not an accent plus a base. */
const LATIN: Record<string, string> = {
  æ: 'ae',
  ø: 'o',
  å: 'a',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
  ħ: 'h',
  ŧ: 't',
  ŋ: 'ng',
  ĸ: 'k'
}

const TABLE: Record<string, string> = { ...LATIN, ...CYRILLIC, ...GREEK }

/**
 * Best-effort ASCII for a string.
 *
 * Anything with no romanisation — CJK, Arabic, Hebrew, Thai — is returned
 * unchanged rather than dropped, so a caller can tell "nothing to transliterate"
 * from "nothing left".
 */
export function transliterate(value: string): string {
  const decomposed = value.normalize('NFKD').replace(/\p{Diacritic}/gu, '')

  let out = ''

  for (const character of decomposed) {
    const lower = character.toLowerCase()
    const mapped = TABLE[lower]

    if (mapped === undefined) {
      out += character
      continue
    }

    // `Привет` keeps its shape: a capital maps to a capitalised romanisation.
    out += character === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1)
  }

  return out
}

/** Is every character in the ASCII range? */
export function isAscii(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is the ASCII range, controls included.
  return /^[\x00-\x7f]*$/.test(value)
}
