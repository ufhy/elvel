import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { JsxViewFactory } from '../src/factory.ts'
import { classes, json, stream, styles } from '../src/index.ts'

beforeEach(() => {
  const app = new Application(process.cwd())
  app.instance('view' as never, new JsxViewFactory() as never)
})

describe('streaming a page', () => {
  function Shell({ title }: { title: string }) {
    return `<h1>${title}</h1>`
  }

  function Slow({ label }: { label: string }) {
    return Bun.sleep(20).then(() => `<p>${label}</p>`)
  }

  function Broken() {
    throw new Error('this part failed')
  }

  test('the shell arrives before the slow part is ready', async () => {
    const response = stream([
      [Shell as never, { title: 'Dashboard' }],
      [Slow as never, { label: 'stats' }]
    ])

    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const first = new TextDecoder().decode((await reader.read()).value)

    // The whole point: a page whose slowest query takes two seconds shows a
    // title immediately instead of a blank tab.
    expect<boolean>(first.includes('<h1>Dashboard</h1>')).toBe(true)
    expect<boolean>(first.includes('stats')).toBe(false)

    await reader.cancel()
  })

  test('a failing part does not truncate the page', async () => {
    const reported: unknown[] = []

    const response = stream(
      [
        [Shell as never, { title: 'Dashboard' }],
        [Broken as never, {}],
        [Shell as never, { title: 'Footer' }]
      ],
      {},
      (error) => reported.push(error)
    )

    const html = await response.text()

    // The status went out with the first byte; throwing now would cut the
    // response off with nothing in the markup to say why.
    expect<boolean>(html.includes('<h1>Dashboard</h1>')).toBe(true)
    expect<boolean>(html.includes('part failed')).toBe(true)
    expect<boolean>(html.includes('<h1>Footer</h1>')).toBe(true)
    expect<number>(reported.length).toBe(1)
  })

  test('nothing downstream is allowed to buffer it', () => {
    const response = stream([[Shell as never, { title: 'x' }]])

    expect<string | null>(response.headers.get('x-accel-buffering')).toBe('no')
  })
})

describe('class, style and json helpers', () => {
  /** What a browser does to the escapes, so a test can compare values. */
  const readable = (value: string) =>
    value
      .replaceAll('\\u0022', '\\"')
      .replaceAll('\\u0027', "'")
      .replaceAll('\\u003c', '<')
      .replaceAll('\\u003e', '>')
      .replaceAll('\\u0026', '&')

  test('classes takes strings and conditions', () => {
    expect<string>(classes('card', { 'card--wide': true, 'is-active': false })).toBe(
      'card card--wide'
    )
    // A falsy input contributes nothing rather than the word "false", which is
    // what the hand-rolled join does.
    expect<string>(classes('card', false, null, undefined)).toBe('card')
    expect<string>(classes()).toBe('')
  })

  test('and does not deduplicate, which is what Laravel does', () => {
    // `Arr::toCssClasses` joins what it was given. Removing duplicates reads
    // like an improvement and is an undocumented difference from Laravel.
    expect<string>(classes('card card', { card: true })).toBe('card card card')
  })

  test('styles writes declarations, terminated', () => {
    expect<string>(
      styles('color: red', { 'font-weight: bold': true, 'display: none': false })
    ).toBe('color: red; font-weight: bold;')
    // Terminated on purpose: appending another declaration later must not merge
    // two properties into one.
    expect<string>(styles('color: red;')).toBe('color: red;')
    expect<string>(styles({ 'color: red': false })).toBe('')
  })

  test('json escapes the same set Laravel does', () => {
    // @json encodes with JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_AMP |
    // JSON_HEX_QUOT — the quotes are what make it safe in an attribute as well
    // as in a script body.
    const escaped = json({ says: `he said "hi", it's fine <b>&</b>` })

    for (const character of ['<', '>', '&', "'"]) {
      expect(escaped.includes(character)).toBe(false)
    }

    // The structural quotes stay; only the ones inside strings are escaped.
    expect(escaped.startsWith('{"says":"')).toBe(true)
    expect(escaped).toContain('\\u0022hi\\u0022')

    // And it is still the same value once a browser has parsed it.
    expect<unknown>(JSON.parse(readable(escaped))).toEqual({
      says: `he said "hi", it's fine <b>&</b>`
    })
  })

  test('json escapes what a script tag can be broken out of', () => {
    const embedded = json({ bio: '</script><img src=x onerror=alert(1)>' })

    // The escaping HTML needs is not the escaping a script body needs: the
    // parser is looking for the literal `</script`, and JSON.stringify has no
    // reason to care.
    expect(embedded).not.toContain('</script')
    expect(embedded).toContain('\\u003c')

    // And it is still JSON: what comes out the other side is the original.
    expect<unknown>(
      JSON.parse(embedded.replaceAll('\\u003c', '<').replaceAll('\\u003e', '>'))
    ).toEqual({
      bio: '</script><img src=x onerror=alert(1)>'
    })
  })

  test('json escapes the line separators that are legal in JSON and not in JS', () => {
    // U+2028 inside a JSON string is fine; inside a script body it is a line
    // terminator, so leaving it produces a syntax error in the page.
    expect(json({ a: 'x y' })).toBe('{"a":"x\\u2028y"}')
  })

  test('json of nothing is null, not undefined', () => {
    // `undefined` is not JSON and would be written into the script as the bare
    // identifier, which throws at parse time.
    expect<string>(json(undefined)).toBe('null')
  })
})
