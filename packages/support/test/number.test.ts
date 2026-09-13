import { afterEach, describe, expect, test } from 'bun:test'
import {
  defaultCurrency,
  defaultLocale,
  Number as N,
  useCurrency,
  useLocale,
  withCurrency,
  withLocale
} from '../src/number.ts'

afterEach(() => {
  useLocale('en')
  useCurrency('USD')
})

describe('locale', () => {
  test('the default applies to every call', () => {
    useLocale('de-DE')
    expect(N.format(1234.5)).toBe('1.234,5')
  })

  test('a call can override it without moving the default', () => {
    expect(N.format(1234.5, { locale: 'de-DE' })).toBe('1.234,5')
    expect(defaultLocale()).toBe('en')
  })

  test('withLocale restores even when the callback throws', () => {
    expect(() =>
      withLocale('fr-FR', () => {
        throw new Error('boom')
      })
    ).toThrow('boom')

    expect(defaultLocale()).toBe('en')
  })

  test('and the same for the currency', () => {
    withCurrency('JPY', () => expect(defaultCurrency()).toBe('JPY'))
    expect(defaultCurrency()).toBe('USD')
  })
})

describe('currency', () => {
  test('uses the configured currency and locale together', () => {
    useLocale('id-ID')
    useCurrency('IDR')

    // Whatever ICU says for the locale, including whether there is a space
    // after the symbol — `id-ID` has none, and taking its answer is the point.
    expect(N.currency(1_250_000)).toBe('Rp1.250.000,00')
  })

  test('a currency argument beats the default', () => {
    expect(N.currency(10, 'GBP')).toBe('£10.00')
  })
})

describe('percentage', () => {
  test('takes a percentage, not a fraction', () => {
    expect(N.percentage(17.5)).toBe('18%')
    expect(N.percentage(17.5, { maximumFractionDigits: 1 })).toBe('17.5%')
  })
})

describe('fileSize', () => {
  test('powers of two with the decimal names', () => {
    expect(N.fileSize(1024)).toBe('1 KB')
    expect(N.fileSize(1536, 1)).toBe('1.5 KB')
    expect(N.fileSize(1_048_576)).toBe('1 MB')
  })

  test('bytes are never fractional', () => {
    expect(N.fileSize(999, 2)).toBe('999 B')
  })

  test('and a negative size keeps its sign', () => {
    expect(N.fileSize(-2048)).toBe('-2 KB')
  })
})

describe('forHumans and abbreviate', () => {
  test('the two spellings of the same summary', () => {
    expect(N.forHumans(1200, 1)).toBe('1.2 thousand')
    expect(N.abbreviate(1200, 1)).toBe('1.2K')
  })

  test('the largest suffix that fits is the one used', () => {
    expect(N.abbreviate(1_250_000, 1)).toBe('1.3M')
    expect(N.abbreviate(2_000_000_000)).toBe('2B')
  })

  test('a number below a thousand is left alone', () => {
    expect(N.abbreviate(999)).toBe('999')
  })

  test('and a negative one keeps its sign and its suffix', () => {
    expect(N.abbreviate(-1500, 1)).toBe('-1.5K')
  })
})

describe('ordinal', () => {
  test('English suffixes come from the plural rules, not a modulo', () => {
    expect(N.ordinal(1)).toBe('1st')
    expect(N.ordinal(2)).toBe('2nd')
    expect(N.ordinal(3)).toBe('3rd')
    expect(N.ordinal(4)).toBe('4th')
  })

  /** The case a hand-written `% 10` gets wrong. */
  test('eleven, twelve and thirteen are all `th`', () => {
    expect(N.ordinal(11)).toBe('11th')
    expect(N.ordinal(12)).toBe('12th')
    expect(N.ordinal(13)).toBe('13th')
    expect(N.ordinal(21)).toBe('21st')
  })
})

describe('clamp, trim and pairs', () => {
  test('clamp', () => {
    expect(N.clamp(15, 1, 10)).toBe(10)
    expect(N.clamp(-1, 1, 10)).toBe(1)
    expect(N.clamp(5, 1, 10)).toBe(5)
  })

  test('trim drops trailing zeros', () => {
    expect(N.trim(1.5)).toBe(1.5)
    expect(N.trim(1.0)).toBe(1)
  })

  test('pairs covers the whole range and stops at the total', () => {
    expect(N.pairs(25, 10)).toEqual([
      [1, 10],
      [11, 20],
      [21, 25]
    ])
  })

  test('and an exact multiple has no short last page', () => {
    expect(N.pairs(20, 10)).toEqual([
      [1, 10],
      [11, 20]
    ])
  })

  test('a step of zero is an error rather than a hang', () => {
    expect(() => N.pairs(10, 0)).toThrow('at least 1')
  })
})
