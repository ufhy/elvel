/**
 * Formatting numbers for people, over `Intl`.
 *
 * No `spell()`. ECMA-402 has no rule-based number formatting, so there is no way
 * to reach ICU's spellout from JavaScript, and a hand-written English speller in
 * a framework that ships a translator would be the wrong file for it.
 *
 * The locale is a module-level default rather than a parameter everywhere,
 * because almost every call in an application wants the same one and passing it
 * to each would mean threading it through every view. `withLocale()` scopes a
 * change; the third argument overrides one call.
 */

let currentLocale = 'en'
let currentCurrency = 'USD'

/** Set the default for the process. The framework calls this from `app.locale`. */
export function useLocale(locale: string): void {
  currentLocale = locale
}

/** Set the default currency for the process. */
export function useCurrency(currency: string): void {
  currentCurrency = currency
}

export function defaultLocale(): string {
  return currentLocale
}

export function defaultCurrency(): string {
  return currentCurrency
}

/**
 * Run `callback` with a different default locale, restoring it afterwards.
 *
 * Synchronous on purpose. An `await` inside would put the swapped locale in
 * front of every other request in the process, which is the bug the translator
 * still has.
 */
export function withLocale<T>(locale: string, callback: () => T): T {
  const previous = currentLocale

  currentLocale = locale

  try {
    return callback()
  } finally {
    currentLocale = previous
  }
}

/** The same for the currency. */
export function withCurrency<T>(currency: string, callback: () => T): T {
  const previous = currentCurrency

  currentCurrency = currency

  try {
    return callback()
  } finally {
    currentCurrency = previous
  }
}

export type FormatOptions = Intl.NumberFormatOptions & { locale?: string }

const SUFFIXES: Array<[number, string, string]> = [
  [1e15, 'Q', ' quadrillion'],
  [1e12, 'T', ' trillion'],
  [1e9, 'B', ' billion'],
  [1e6, 'M', ' million'],
  [1e3, 'K', ' thousand']
]

const ORDINAL_SUFFIX: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' }

export const Number_ = {
  /** `1234.5` → `1,234.5`. */
  format(value: number, options: FormatOptions = {}): string {
    const { locale, ...rest } = options

    return new Intl.NumberFormat(locale ?? currentLocale, rest).format(value)
  },

  /** `1250000` → `$1,250,000.00`, or `Rp 1.250.000` under `id-ID`. */
  currency(value: number, currency?: string, options: FormatOptions = {}): string {
    return Number_.format(value, {
      style: 'currency',
      currency: currency ?? currentCurrency,
      ...options
    })
  },

  /** `17.5` → `17.5%`. The value is a percentage already, not a fraction. */
  percentage(value: number, options: FormatOptions = {}): string {
    return Number_.format(value / 100, {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: options.maximumFractionDigits ?? 0,
      ...options
    })
  },

  /**
   * `1024` → `1 KB`.
   *
   * Powers of two with the decimal names, which is what a file manager shows and
   * what a person comparing the two expects to match.
   */
  fileSize(bytes: number, precision = 0, options: FormatOptions = {}): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

    let size = Math.abs(bytes)
    let unit = 0

    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024
      unit += 1
    }

    const signed = bytes < 0 ? -size : size

    return `${Number_.format(signed, {
      minimumFractionDigits: unit === 0 ? 0 : precision,
      maximumFractionDigits: unit === 0 ? 0 : precision,
      ...options
    })} ${units[unit]}`
  },

  /** `1200` → `1.2 thousand`. */
  forHumans(value: number, precision = 0, options: FormatOptions = {}): string {
    return summarise(value, precision, false, options)
  },

  /** `1200` → `1.2K`. */
  abbreviate(value: number, precision = 0, options: FormatOptions = {}): string {
    return summarise(value, precision, true, options)
  },

  /**
   * `1` → `1st`.
   *
   * The suffix comes from `Intl.PluralRules` in ordinal mode, so a locale with
   * different rules gets them right; the English table is the fallback for a
   * locale `Intl` has no ordinal data for.
   */
  ordinal(value: number, options: { locale?: string } = {}): string {
    const locale = options.locale ?? currentLocale

    try {
      const rule = new Intl.PluralRules(locale, { type: 'ordinal' }).select(value)

      return `${value}${ORDINAL_SUFFIX[rule] ?? 'th'}`
    } catch {
      return `${value}${ORDINAL_SUFFIX.other}`
    }
  },

  /** Keep a number inside a range. */
  clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  },

  /**
   * `pairs(25, 10)` → `[[1, 10], [11, 20], [21, 25]]`.
   *
   * For paging a list into labelled ranges — "1–10 of 25" — without the
   * off-by-one everybody writes at the last page.
   */
  pairs(total: number, step: number, offset = 1): Array<[number, number]> {
    if (step <= 0) throw new Error('Number.pairs needs a step of at least 1.')

    const out: Array<[number, number]> = []

    for (let start = offset; start <= total; start += step) {
      out.push([start, Math.min(start + step - offset, total)])
    }

    return out
  },

  /** Drop trailing zeros: `1.50` → `1.5`, `1.00` → `1`. */
  trim(value: number): number {
    return Number.parseFloat(String(value))
  }
}

function summarise(
  value: number,
  precision: number,
  abbreviate: boolean,
  options: FormatOptions
): string {
  const magnitude = Math.abs(value)

  for (const [size, short, long] of SUFFIXES) {
    if (magnitude < size) continue

    const scaled = value / size

    return `${Number_.format(scaled, {
      minimumFractionDigits: 0,
      maximumFractionDigits: precision,
      ...options
    })}${abbreviate ? short : long}`
  }

  return Number_.format(value, {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
    ...options
  })
}

export { Number_ as Number }
