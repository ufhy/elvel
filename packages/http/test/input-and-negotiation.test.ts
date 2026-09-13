import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { conditionalPlugin, etag } from '../src/conditional.ts'
import { InputBag, inputs } from '../src/input.ts'
import {
  accepts,
  acceptsAnyContentType,
  getAcceptableContentTypes,
  prefers
} from '../src/negotiation.ts'
import { UploadedFile } from '../src/uploaded-file.ts'

const bag = (data: Record<string, unknown>) => new InputBag(data)

describe('reading input', () => {
  const form = bag({
    name: 'Ada',
    age: '36',
    ratio: '1.5',
    subscribed: 'on',
    tags: ['a', 'b'],
    address: { city: 'London' },
    blank: '',
    nothing: null
  })

  test('dot access, with a default', () => {
    expect(form.input<string>('address.city')).toBe('London')
    expect(form.input('address.county', 'none')).toBe('none')
  })

  test('has, hasAny and missing', () => {
    expect(form.has('name', 'age')).toBe(true)
    expect(form.has('name', 'nope')).toBe(false)
    expect(form.hasAny('nope', 'age')).toBe(true)
    expect(form.missing('nope')).toBe(true)
  })

  /** `0` and `false` are filled; `''`, `[]` and `null` are not. */
  test('filled draws the line where a form does', () => {
    expect(form.filled('name')).toBe(true)
    expect(form.filled('blank')).toBe(false)
    expect(form.filled('nothing')).toBe(false)
    expect(bag({ count: 0, off: false }).filled('count', 'off')).toBe(true)
  })

  test('only and except', () => {
    expect(form.only(['name', 'age'])).toEqual({ name: 'Ada', age: '36' })
    expect(Object.keys(form.except(['name', 'age', 'ratio', 'subscribed']))).toEqual([
      'tags',
      'address',
      'blank',
      'nothing'
    ])
  })

  test('merge and mergeIfMissing', () => {
    const values = bag({ name: 'Ada' })

    values.merge({ role: 'admin' }).mergeIfMissing({ name: 'Grace', locale: 'en' })

    expect(values.all()).toEqual({ name: 'Ada', role: 'admin', locale: 'en' })
  })

  test('whenHas and whenFilled', () => {
    expect(form.whenHas('name', (value) => value)).toBe('Ada')
    expect(
      form.whenHas(
        'nope',
        (value) => value,
        () => 'fallback'
      )
    ).toBe('fallback')
    expect(
      form.whenFilled(
        'blank',
        () => 'yes',
        () => 'no'
      )
    ).toBe('no')
  })

  test('collect', () => {
    expect(form.collect('tags').all()).toEqual(['a', 'b'])
    expect(form.collect('name').all()).toEqual(['Ada'])
  })
})

/** The coercion every application writes again, wrong in a different way each time. */
describe('the typed readers', () => {
  test('an unchecked checkbox is absent, a checked one is "on"', () => {
    const form = bag({ subscribed: 'on', terms: '0', beta: 'false' })

    expect(form.boolean('subscribed')).toBe(true)
    expect(form.boolean('terms')).toBe(false)
    expect(form.boolean('beta')).toBe(false)
    expect(form.boolean('newsletter')).toBe(false)
  })

  test('string, integer and float', () => {
    const form = bag({ name: 'Ada', age: '36', ratio: '1.5', bad: 'x' })

    expect(form.string('name')).toBe('Ada')
    expect(form.string('nope', 'none')).toBe('none')
    expect(form.integer('age')).toBe(36)
    expect(form.integer('ratio', 7)).toBe(7)
    expect(form.float('ratio')).toBe(1.5)
    expect(form.float('bad', -1)).toBe(-1)
  })

  test('date', () => {
    const form = bag({ at: '2026-08-11T09:30:00.000Z', bad: 'not a date' })

    expect(form.date('at')?.toISOString()).toBe('2026-08-11T09:30:00.000Z')
    expect(form.date('bad')).toBeUndefined()
    expect(form.date('nope')).toBeUndefined()
  })

  /** Picking a default for a value outside the set is how an order lands in the wrong state. */
  test('enum answers nothing for a case we do not serve', () => {
    const form = bag({ status: 'shipped', other: 'exploded' })

    expect(form.enum('status', ['pending', 'shipped'] as const)).toBe('shipped')
    expect(form.enum('other', ['pending', 'shipped'] as const)).toBeUndefined()
  })

  test('array wraps a single value', () => {
    expect(bag({ tags: 'a' }).array('tags')).toEqual(['a'])
    expect(bag({}).array('tags')).toEqual([])
  })
})

describe('inputs()', () => {
  test('merges the query string and the body, body winning', () => {
    const source = {
      request: new Request('http://example.com/search?page=1&sort=new'),
      body: { page: '2' }
    }

    expect(inputs(source).all()).toEqual({ page: '2', sort: 'new' })
  })
})

describe('content negotiation', () => {
  const from = (accept: string) => ({ headers: { accept } })

  test('accepts answers the first type the header allows', () => {
    expect(accepts(['text/html', 'application/json'], from('application/json'))).toBe(
      'application/json'
    )
    expect(accepts(['text/csv'], from('application/json'))).toBeUndefined()
  })

  test('prefers ranks by what the header wants, not by our order', () => {
    const header = from('text/csv;q=0.9, application/json;q=0.4')

    expect(prefers(['application/json', 'text/csv'], header)).toBe('text/csv')
  })

  /** Where hand-parsing goes wrong. */
  test('quality values decide, and a zero is a refusal', () => {
    expect(
      prefers(['text/html', 'application/json'], from('text/html;q=0.2,application/json'))
    ).toBe('application/json')
    expect(accepts(['text/html'], from('text/html;q=0'))).toBeUndefined()
  })

  test('a wildcard matches, and specificity breaks a tie', () => {
    expect(accepts(['text/csv'], from('text/*'))).toBe('text/csv')
    expect(prefers(['text/csv', 'text/html'], from('*/*, text/html'))).toBe('text/html')
    expect(acceptsAnyContentType(from('*/*'))).toBe(true)
  })

  test('no Accept at all takes whatever we send', () => {
    expect(accepts(['text/html'], { headers: {} })).toBe('text/html')
    expect(acceptsAnyContentType({ headers: {} })).toBe(true)
  })

  test('getAcceptableContentTypes lists them best first', () => {
    expect(getAcceptableContentTypes(from('text/html;q=0.5, application/json'))).toEqual([
      'application/json',
      'text/html'
    ])
  })
})

describe('a conditional GET', () => {
  const app = () =>
    new Elysia().use(conditionalPlugin()).get('/', ({ set }) => {
      set.headers.etag = '"v1"'

      return 'body'
    })

  const press = (headers: Record<string, string> = {}) =>
    app().handle(new Request('http://example.com/', { headers }))

  test('a fresh client is answered in full', async () => {
    const response = await press()

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"v1"')
  })

  /** The cheapest response there is. */
  test('a matching If-None-Match answers 304 with no body', async () => {
    const response = await press({ 'if-none-match': '"v1"' })

    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    expect(response.headers.get('etag')).toBe('"v1"')
  })

  test('a weak tag matches a strong one of the same value', async () => {
    expect((await press({ 'if-none-match': 'W/"v1"' })).status).toBe(304)
  })

  test('and a different tag does not', async () => {
    expect((await press({ 'if-none-match': '"v2"' })).status).toBe(200)
  })

  test('If-Modified-Since works the same way', async () => {
    const served = new Elysia().use(conditionalPlugin()).get('/', ({ set }) => {
      set.headers['last-modified'] = new Date('2026-08-11T09:00:00.000Z').toUTCString()

      return 'body'
    })

    const fresh = await served.handle(
      new Request('http://example.com/', {
        headers: { 'if-modified-since': new Date('2026-08-11T10:00:00.000Z').toUTCString() }
      })
    )

    expect(fresh.status).toBe(304)

    const stale = await served.handle(
      new Request('http://example.com/', {
        headers: { 'if-modified-since': new Date('2026-08-11T08:00:00.000Z').toUTCString() }
      })
    )

    expect(stale.status).toBe(200)
  })

  test('a response nothing tagged is left alone', async () => {
    const plain = new Elysia().use(conditionalPlugin()).get('/', () => 'body')

    const response = await plain.handle(
      new Request('http://example.com/', { headers: { 'if-none-match': '"anything"' } })
    )

    expect(response.status).toBe(200)
  })

  test('etag() hashes a value', () => {
    expect(etag('a')).toBe(etag('a'))
    expect(etag('a')).not.toBe(etag('b'))
    expect(etag('a', true)).toStartWith('W/')
  })
})

describe('an uploaded file', () => {
  const upload = (name: string) =>
    new UploadedFile(new File(['bytes'], name, { type: 'image/png' }))

  /** A browser sends a bare filename; anything else sent this deliberately. */
  test('the client name is stripped of every path segment', () => {
    expect(upload('../../etc/passwd').clientOriginalName()).toBe('passwd')
    expect(upload('C:\\Users\\me\\avatar.png').clientOriginalName()).toBe('avatar.png')
  })

  test('the extension is lowercased and sanitised', () => {
    expect(upload('Avatar.PNG').clientExtension()).toBe('png')
    expect(upload('noextension').clientExtension()).toBe('')
  })

  test('hashName keeps the extension and nothing else about the client', () => {
    const name = upload('../../etc/passwd.png').hashName()

    expect(name).toMatch(/^[0-9a-f]{32}\.png$/)
    expect(upload('a.png').hashName('avatars')).toMatch(/^avatars\/[0-9a-f]{32}\.png$/)
  })

  test('two uploads of the same bytes do not share a path', () => {
    expect(upload('a.png').hashName()).not.toBe(upload('a.png').hashName())
  })

  /** Silently flattening it would hide the attempt. */
  test('storeAs refuses a name carrying a path', async () => {
    await expect(upload('a.png').storeAs('avatars', '../x.png')).rejects.toThrow(
      'is not a filename'
    )
  })
})
