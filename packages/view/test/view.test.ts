import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Application } from '@elysian/core'
import { JsxViewFactory } from '../src/factory.ts'
import { stream } from '../src/index.ts'
import { Vite } from '../src/vite.ts'

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

describe('Vite tags', () => {
  const build = async (files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), 'elysian-vite-'))

    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, name)), { recursive: true })
      await Bun.write(join(root, name), contents)
    }

    return root
  }

  test('production tags come from the manifest, hashed', async () => {
    const root = await build({
      'build/manifest.json': JSON.stringify({
        'resources/js/app.ts': { file: 'assets/app-abc123.js', css: ['assets/app-def456.css'] }
      })
    })

    try {
      const tags = new Vite({ publicPath: root }).tags('resources/js/app.ts')

      // Without the hash a deploy ships stale JavaScript to anybody with a warm
      // cache, and a cache-busting query string defeats caching entirely.
      expect<boolean>(tags.includes('/build/assets/app-abc123.js')).toBe(true)
      // Stylesheet first, so the page does not paint unstyled.
      expect<boolean>(tags.indexOf('.css') < tags.indexOf('.js')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the dev server wins when it is running', async () => {
    const root = await build({
      hot: 'http://localhost:5173\n',
      'build/manifest.json': JSON.stringify({ 'app.ts': { file: 'assets/app-abc.js' } })
    })

    try {
      const tags = new Vite({ publicPath: root }).tags('app.ts')

      // The client is what opens the socket updates arrive over, so it is not
      // optional and it comes first.
      expect<boolean>(tags.includes('http://localhost:5173/@vite/client')).toBe(true)
      expect<boolean>(tags.includes('http://localhost:5173/app.ts')).toBe(true)
      expect<boolean>(tags.includes('abc')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a missing entry names itself and the manifest', async () => {
    const root = await build({ 'build/manifest.json': JSON.stringify({}) })

    try {
      // The usual cause is a build that has not run, and "undefined is not a
      // chunk" says none of that.
      expect(() => new Vite({ publicPath: root }).tags('app.ts')).toThrow('Has the build run?')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('no manifest at all says what to do', () => {
    expect(() => new Vite({ publicPath: '/nowhere' }).tags('app.ts')).toThrow('Run the build')
  })
})
