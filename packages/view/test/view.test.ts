import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elysian/core'
import { JsxViewFactory } from '../src/factory.ts'
import { stream } from '../src/index.ts'

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
