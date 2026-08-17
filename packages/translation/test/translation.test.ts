import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('whole-sentence translations', () => {
  const translator = () =>
    new Translator('id', 'en')
      .add('en', 'orders', { title: 'Orders' })
      .add('id', 'orders', { title: 'Pesanan' })
      .addSentences('id', {
        'You have no orders yet.': 'Kamu belum punya pesanan.',
        'Hello :name': 'Halo :name'
      })

  test('the sentence is the key', () => {
    // The reason these exist: no key has to be invented, and the source reads as
    // the sentence it will show.
    expect<string>(translator().get('You have no orders yet.')).toBe('Kamu belum punya pesanan.')
  })

  test('an untranslated sentence shows itself, which is still readable', () => {
    expect<string>(translator().get('Nothing has been translated here.')).toBe(
      'Nothing has been translated here.'
    )
  })

  test('placeholders work the same as in a dotted key', () => {
    expect<string>(translator().get('Hello :name', { name: 'Ada' })).toBe('Halo Ada')
  })

  test('sentences and dotted keys do not collide', () => {
    const trans = translator()

    expect<string>(trans.get('orders.title')).toBe('Pesanan')
    expect<string>(trans.get('You have no orders yet.')).toBe('Kamu belum punya pesanan.')
  })

  test('has() looks in the fallback, hasForLocale does not', () => {
    const trans = translator()

    // `orders.title` exists in both; a key only English has is the interesting
    // case, since that is what a half-translated locale looks like.
    trans.add('en', 'billing', { invoice: 'Invoice' })

    expect(trans.has('billing.invoice')).toBe(true)
    expect(trans.hasForLocale('billing.invoice')).toBe(false)
    expect(trans.hasForLocale('billing.invoice', 'en')).toBe(true)
  })

  test('whenMissing sees every key nothing translated', () => {
    const seen: Array<[string, string]> = []

    const trans = translator().whenMissing((key, locale) => {
      seen.push([key, locale])

      return undefined
    })

    expect<string>(trans.get('orders.title')).toBe('Pesanan')
    expect<string>(trans.get('orders.nowhere')).toBe('orders.nowhere')
    expect<Array<[string, string]>>(seen).toEqual([['orders.nowhere', 'id']])
  })

  test('and can answer for it', () => {
    const trans = translator().whenMissing((key) => `[[${key}]]`)

    // Loud on purpose: a test run can fail on this, where a returned key looks
    // like an ordinary string.
    expect<string>(trans.get('orders.nowhere')).toBe('[[orders.nowhere]]')
  })

  test('the fallback locale can be changed after construction', () => {
    const trans = new Translator('id', 'en').add('fr', 'orders', { title: 'Commandes' })

    expect<string>(trans.get('orders.title')).toBe('orders.title')
    expect<string>(trans.setFallback('fr').get('orders.title')).toBe('Commandes')
    expect<string>(trans.getFallback()).toBe('fr')
  })
})

describe('loading a lang directory', () => {
  test('it reads both shapes: a locale directory and a locale json file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elvel-lang-'))

    try {
      await mkdir(join(root, 'id'), { recursive: true })
      await writeFile(
        join(root, 'id', 'orders.ts'),
        'export default { title: "Pesanan" }\n',
        'utf8'
      )
      await writeFile(
        join(root, 'id.json'),
        JSON.stringify({ 'You have no orders yet.': 'Kamu belum punya pesanan.' }),
        'utf8'
      )

      const trans = await new Translator('id', 'en').load(root)

      expect<string>(trans.get('orders.title')).toBe('Pesanan')
      expect<string>(trans.get('You have no orders yet.')).toBe('Kamu belum punya pesanan.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a malformed json file does not stop the rest from loading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elvel-lang-'))

    try {
      await mkdir(join(root, 'id'), { recursive: true })
      await writeFile(
        join(root, 'id', 'orders.ts'),
        'export default { title: "Pesanan" }\n',
        'utf8'
      )
      await writeFile(join(root, 'id.json'), '{ not json', 'utf8')

      const trans = await new Translator('id', 'en').load(root)

      // Refusing to boot over one language file is a worse trade than showing
      // the untranslated sentences, which are still readable.
      expect<string>(trans.get('orders.title')).toBe('Pesanan')
      expect<string>(trans.get('Anything at all.')).toBe('Anything at all.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
