import { describe, expect, test } from 'bun:test'
import { choose, pluralIndex } from '../src/selector.ts'
import { interpolate, Translator } from '../src/translator.ts'

const translator = () => {
  const instance = new Translator('id', 'en')

  instance.add('en', 'orders', {
    title: 'Orders',
    greeting: 'Hello :name, you have :count orders',
    count: '{0} no orders|[1,1] one order|[2,*] :count orders',
    only_english: 'Only in English'
  })

  instance.add('id', 'orders', {
    title: 'Pesanan',
    greeting: 'Halo :name, kamu punya :count pesanan'
  })

  return instance
}

describe('looking a message up', () => {
  test('it reads the current locale', () => {
    expect<string>(translator().get('orders.title')).toBe('Pesanan')
  })

  test('and falls back before giving up', () => {
    // A half-translated locale should show English for what it is missing,
    // rather than raw keys on an otherwise finished page.
    expect<string>(translator().get('orders.only_english')).toBe('Only in English')
  })

  test('a missing key returns the key itself', () => {
    // Obviously wrong and obviously fixable. An empty string shows a page that
    // looks finished and says nothing.
    expect<string>(translator().get('orders.missing')).toBe('orders.missing')
  })

  test('placeholders match the case they were written in', () => {
    expect<string>(interpolate('Hello :name', { name: 'ada' })).toBe('Hello ada')
    expect<string>(interpolate('Hello :Name', { name: 'ada' })).toBe('Hello Ada')
    expect<string>(interpolate('HELLO :NAME', { name: 'ada' })).toBe('HELLO ADA')
  })

  test('a longer placeholder is not eaten by a shorter one', () => {
    expect<string>(interpolate(':name_first :name', { name: 'Ada', name_first: 'A.' })).toBe(
      'A. Ada'
    )
  })
})

describe('choosing by count', () => {
  test('an exact condition wins over the plural rule', () => {
    const instance = translator().setLocale('en')

    // Plural rules cannot express "none": a two-form language still wants a
    // different sentence for zero.
    expect<string>(instance.choice('orders.count', 0)).toBe('no orders')
    expect<string>(instance.choice('orders.count', 1)).toBe('one order')
    expect<string>(instance.choice('orders.count', 7)).toBe('7 orders')
  })

  test('count is filled in without being passed twice', () => {
    expect<string>(choose('{0} none|[1,*] :count items', 3, 'en')).toBe(':count items')
    expect<string>(translator().setLocale('en').choice('orders.count', 3)).toBe('3 orders')
  })

  test('positional forms fall back to the locale rule', () => {
    expect<string>(choose('one|many', 1, 'en')).toBe('one')
    expect<string>(choose('one|many', 5, 'en')).toBe('many')
    // French counts zero as singular; English does not.
    expect<string>(choose('un|plusieurs', 0, 'fr')).toBe('un')
    expect<string>(choose('one|many', 0, 'en')).toBe('many')
  })

  test('a locale with one form always takes the first', () => {
    expect<number>(pluralIndex('id', 0)).toBe(0)
    expect<number>(pluralIndex('id', 9)).toBe(0)
  })

  test('the Slavic three-form rule', () => {
    expect<number>(pluralIndex('ru', 1)).toBe(0)
    expect<number>(pluralIndex('ru', 3)).toBe(1)
    expect<number>(pluralIndex('ru', 11)).toBe(2)
  })

  test('an unknown locale falls back rather than throwing', () => {
    // A slightly wrong plural beats a crash inside a view.
    expect<number>(pluralIndex('xx', 1)).toBe(0)
    expect<number>(pluralIndex('xx', 2)).toBe(1)
  })
})
