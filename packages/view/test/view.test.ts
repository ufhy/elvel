import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Application } from '@elvel/core'
import { JsxViewFactory } from '../src/factory.ts'
import { classes, json, stream, styles } from '../src/index.ts'
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
    const root = await mkdtemp(join(tmpdir(), 'elvel-vite-'))

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

  test('a stylesheet two entries share is found in the chunk they share', async () => {
    /**
     * The failure this prevents is silent. Rollup hoists a stylesheet imported by
     * more than one entry into a shared chunk, so both entries come back with
     * `css: []` and the page renders as unstyled HTML with nothing in the console.
     * Measured the first time an application had two entries.
     */
    const root = await build({
      'build/manifest.json': JSON.stringify({
        'src/main.ts': { file: 'assets/main-abc.js', imports: ['_style-xyz.js'] },
        'src/auth.ts': { file: 'assets/auth-def.js', imports: ['_style-xyz.js'] },
        '_style-xyz.js': { file: 'assets/style-xyz.js', css: ['assets/style-123.css'] }
      })
    })

    try {
      const vite = new Vite({ publicPath: root })

      for (const entry of ['src/main.ts', 'src/auth.ts']) {
        const tags = vite.tags(entry)

        expect<boolean>(tags.includes('/build/assets/style-123.css')).toBe(true)
        expect<boolean>(tags.indexOf('.css') < tags.indexOf('.js')).toBe(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the manifest is found where Vite 5 puts it, too', async () => {
    // A project that set `manifest: true` rather than naming the file has it at
    // `.vite/manifest.json`; before this, that project rendered no tags at all
    // and the page came out unstyled with the build sitting right there.
    const root = await build({
      'build/.vite/manifest.json': JSON.stringify({
        'resources/js/app.ts': { file: 'assets/app-abc123.js' }
      })
    })

    try {
      const tags = new Vite({ publicPath: root }).tags('resources/js/app.ts')

      expect<boolean>(tags.includes('/build/assets/app-abc123.js')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('with no build and no dev server, production says so and stops', async () => {
    const root = await build({})

    try {
      // A deploy that shipped an unstyled page should not do so quietly.
      expect(() => new Vite({ publicPath: root }).tags('resources/js/app.ts')).toThrow(
        /No Vite manifest/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('and elsewhere the page renders without its assets', async () => {
    const root = await build({})

    try {
      // A freshly scaffolded application boots before anybody has run the asset
      // build; a 500 on the landing page is a poor first minute, and one warning
      // says the same thing without breaking the page.
      expect<string>(
        new Vite({ publicPath: root, whenMissing: 'ignore' }).tags('resources/js/app.ts')
      ).toBe('')
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

  /**
   * What the dev server's other plugins asked for, and where it has to go.
   *
   * A Vite plugin injects into the page through `transformIndexHtml`, which needs
   * an `index.html` — and a document the server renders is not one. Measured
   * against the official Vite templates: `@vitejs/plugin-react` lost its Fast
   * Refresh preamble and `vite-plugin-vue-devtools` lost the whole overlay.
   *
   * `@elvel/vite` asks Vite for them when the dev server starts and writes them
   * beside the hot file. This is the half that renders them.
   */
  test('the tags other plugins asked for land between the client and the app', async () => {
    const root = await build({
      hot: 'http://localhost:5173\n',
      'hot-tags.html': '<script type="module">preamble()</script>'
    })

    try {
      const tags = new Vite({ publicPath: root }).tags('app.ts')

      /**
       * The order is the requirement, not a preference.
       *
       * React's preamble installs a global hook its components register against as
       * they evaluate, so it has to run *before* the entry. After it, Fast Refresh
       * is quietly a full reload — which is the failure nobody reports because the
       * page still works.
       */
      expect<boolean>(
        tags.indexOf('preamble()') > tags.indexOf('@vite/client') &&
          tags.indexOf('preamble()') < tags.indexOf('/app.ts')
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('and nothing changes when no plugin asked for anything', async () => {
    const root = await build({ hot: 'http://localhost:5173\n' })

    try {
      const tags = new Vite({ publicPath: root }).tags('app.ts')

      expect<boolean>(tags.includes('@vite/client')).toBe(true)
      expect<number>(tags.split('<script').length - 1).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * The build half of the same seam.
   *
   * `vite-plugin-pwa` injects its `<link rel="manifest">` and its registration
   * script while building, where there is no dev server to ask — so `@elvel/vite`
   * harvests them from the page it builds and drops, and writes them beside the
   * manifest. This renders them.
   */
  test('what a plugin injected during the build is rendered too', async () => {
    const root = await build({
      'build/manifest.json': JSON.stringify({ 'app.ts': { file: 'assets/app-abc.js' } }),
      'build/injected.html': '<link rel="manifest" href="/build/manifest.webmanifest">'
    })

    try {
      const tags = new Vite({ publicPath: root }).tags('app.ts')

      expect<boolean>(tags.includes('rel="manifest"')).toBe(true)

      /**
       * After the entry, not before it.
       *
       * Nothing harvested from a build has to run first — a service worker
       * registers on `load` and a manifest link is not code. The dev counterpart is
       * the opposite: React's preamble has to precede the entry.
       */
      expect<boolean>(tags.indexOf('rel="manifest"') > tags.indexOf('app-abc.js')).toBe(true)
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
