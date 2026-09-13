import { afterEach, describe, expect, test } from 'bun:test'
import { enterWorkContext, withoutRequestContext } from '@elvel/core'
import { FileLoader } from '../src/file-loader.ts'
import { preferredLocale } from '../src/negotiate.ts'
import { Translator } from '../src/translator.ts'

function inRequest<T>(body: () => T): T {
  return withoutRequestContext(() => {
    enterWorkContext()

    return body()
  })
}

function translator(): Translator {
  return new Translator('en', 'en')
    .add('en', 'orders', { title: 'Orders' })
    .add('id', 'orders', { title: 'Pesanan' })
}

describe('the locale is request-scoped', () => {
  test('usingLocale changes it for this request only', () => {
    const trans = translator()

    inRequest(() => {
      trans.usingLocale('id')

      expect(trans.get('orders.title')).toBe('Pesanan')
    })

    expect(trans.get('orders.title')).toBe('Orders')
  })

  test('and the next request starts from the process default', () => {
    const trans = translator()

    inRequest(() => trans.usingLocale('id'))

    expect(inRequest(() => trans.get('orders.title'))).toBe('Orders')
  })

  /**
   * The bug the scope exists for: a sender that awaits a channel used to leave
   * every other request in the process speaking the recipient's language.
   */
  test('an await inside withLocale does not leak to a concurrent caller', async () => {
    const trans = translator()
    const seen: string[] = []

    const sending = trans.withLocale('id', async () => {
      await Bun.sleep(5)

      seen.push(trans.get('orders.title'))
    })

    const other = (async () => {
      await Bun.sleep(1)

      seen.push(trans.get('orders.title'))
    })()

    await Promise.all([sending, other])

    expect(seen).toEqual(['Orders', 'Pesanan'])
  })

  test('setLocale still moves the process default, for a command', () => {
    const trans = translator()

    trans.setLocale('id')

    expect(trans.get('orders.title')).toBe('Pesanan')
  })
})

describe('preferredLocale', () => {
  test('honours the ranking, not the order', () => {
    expect(preferredLocale('en;q=0.8,id;q=0.9', ['en', 'id'])).toBe('id')
  })

  test('matches a base language', () => {
    expect(preferredLocale('id-ID,en;q=0.5', ['en', 'id'])).toBe('id')
  })

  test('and a region we happen to have', () => {
    expect(preferredLocale('pt', ['en', 'pt-BR'])).toBe('pt-BR')
  })

  test('a zero weight is a refusal, not a preference', () => {
    expect(preferredLocale('id;q=0', ['en', 'id'])).toBe(undefined)
  })

  test('nothing matching keeps the default', () => {
    expect(preferredLocale('fr', ['en', 'id'])).toBeUndefined()
    expect(preferredLocale(null, ['en'])).toBeUndefined()
    expect(preferredLocale('en', [])).toBeUndefined()
  })

  test('a wildcard takes the first we have', () => {
    expect(preferredLocale('*', ['en', 'id'])).toBe('en')
  })
})

describe('namespaces', () => {
  test('a package ships its own, addressed by name', () => {
    const trans = new Translator('en').add('en', 'billing::invoice', {
      overdue: 'Your invoice is overdue.'
    })

    expect(trans.get('billing::invoice.overdue')).toBe('Your invoice is overdue.')
  })

  test('and an application overrides one string without copying the file', () => {
    const trans = new Translator('en')
      .add('en', 'billing::invoice', { overdue: 'Overdue.', paid: 'Paid.' })
      .add('en', 'billing::invoice', { overdue: 'Please pay.' })

    expect(trans.get('billing::invoice.overdue')).toBe('Please pay.')
    expect(trans.get('billing::invoice.paid')).toBe('Paid.')
  })

  test('a namespaced key nothing translated is still the key itself', () => {
    expect(new Translator('en').get('billing::invoice.overdue')).toBe('billing::invoice.overdue')
  })
})

describe('a loader', () => {
  afterEach(() => undefined)

  test('can come from anywhere', async () => {
    const trans = new Translator('en')

    await trans.loadFrom({
      locales: async () => ['id'],
      groups: async () => ({ orders: { title: 'Pesanan' } }),
      sentences: async () => ({ 'Thank you.': 'Terima kasih.' })
    })

    expect(trans.get('orders.title', {}, 'id')).toBe('Pesanan')
    expect(trans.get('Thank you.', {}, 'id')).toBe('Terima kasih.')
  })

  test('and under a namespace', async () => {
    const trans = new Translator('en')

    await trans.loadFrom(
      {
        locales: async () => ['en'],
        groups: async () => ({ invoice: { overdue: 'Overdue.' } }),
        sentences: async () => ({})
      },
      'billing'
    )

    expect(trans.get('billing::invoice.overdue')).toBe('Overdue.')
  })

  test('the file loader answers nothing for a directory that is not there', async () => {
    const loader = new FileLoader('/nowhere/at/all')

    expect(await loader.locales()).toEqual([])
    expect(await loader.groups('en')).toEqual({})
    expect(await loader.sentences('en')).toEqual({})
  })
})
