import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import elvel, { applicationRoot, injectedTags } from '../src/index.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-vite-'))
  await writeFile(join(root, 'elvel.ts'), '// the marker an application is known by')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The plugin, as Vite would call it. */
const configured = (options: Parameters<typeof elvel>[0], command = 'build', user = {}) =>
  elvel({ appDirectory: root, ...options }).config(user, { command })

describe('what the plugin answers so an application does not have to', () => {
  test('a build gets the prefix its URLs need, and a dev server does not', () => {
    expect<string>(configured({ input: 'src/main.ts' }, 'build').base).toBe('/build/')

    /**
     * Empty in `serve`, and this is not cosmetic: `base` is also the path the dev
     * server answers under, so `/build/` there sends every module request to a
     * prefix nothing is served from. Measured as a 302 to `/build/` on the page.
     */
    expect<string>(configured({ input: 'src/main.ts' }, 'serve').base).toBe('')
  })

  test('the build writes into the application, whatever directory Vite ran in', () => {
    const config = configured({ input: 'src/main.ts' })

    expect<string>(config.build.outDir).toBe(join(root, 'public', 'build'))
    expect<string | boolean>(config.build.manifest).toBe('manifest.json')
    expect<boolean>(config.build.emptyOutDir).toBe(true)
    expect<unknown>(config.build.rollupOptions.input).toBe('src/main.ts')
  })

  /**
   * Off only where it would swallow its own output.
   *
   * In the scaffold Vite's root *is* the application, so `publicDir` is `public/`
   * and the build writes inside it — Vite's own warning otherwise: "The public
   * directory feature may not work correctly. outDir … and publicDir … are not
   * separate folders."
   */
  test('the public directory is refused when the build writes inside it', () => {
    expect<string | false | undefined>(configured({ input: 'src/main.ts' }).publicDir).toBe(false)
  })

  /**
   * And left alone for a client project of its own — which is not a nicety.
   *
   * Every official Vite template ships `public/favicon.svg` and
   * `public/icons.svg`. Measured against all nine presets with this turned off:
   * the assets never reached the build output in eight of them, silently, and
   * `vue-ts` failed outright — its `HelloWorld.vue` imports `/icons.svg`, and with
   * no public directory there is nothing for that path to resolve to.
   */
  test('a client project keeps its own public directory', () => {
    const client = join(root, 'frontend')

    const config = elvel({ input: 'src/main.ts', appDirectory: client }).config(
      { root: client },
      { command: 'build' }
    )

    expect<boolean>('publicDir' in config).toBe(false)
    expect<string>(config.build.outDir).toBe(join(root, 'public', 'build'))
  })

  test('a renamed build directory moves the prefix and the output together', () => {
    const config = configured({ input: 'src/main.ts', buildDirectory: 'assets' })

    expect<string>(config.base).toBe('/assets/')
    expect<string>(config.build.outDir).toBe(join(root, 'public', 'assets'))
    expect<boolean>(config.server?.watch.ignored.includes('**/public/assets/**')).toBe(true)
  })

  /**
   * A default the application can still overrule.
   *
   * The plugin decides what an application should not have to think about; it does
   * not take the decision away from one that has thought about it.
   */
  test('anything the application set itself wins', () => {
    const config = configured({ input: 'src/main.ts' }, 'build', {
      base: 'https://cdn.example.com/build/',
      publicDir: 'static',
      build: { outDir: 'somewhere/else', manifest: true, emptyOutDir: false }
    })

    expect<string>(config.base).toBe('https://cdn.example.com/build/')

    // A `publicDir` of the application's own is not contradicted: the plugin says
    // nothing about it, and Vite keeps what was set.
    expect<boolean>('publicDir' in config).toBe(false)
    expect<string>(config.build.outDir).toBe('somewhere/else')
    expect<string | boolean>(config.build.manifest).toBe(true)
    expect<boolean>(config.build.emptyOutDir).toBe(false)
  })

  /**
   * The loop this closes fed itself.
   *
   * A running application writes inside the directory Vite watches — a session
   * file per request, a SQLite database, the build output — so a write triggers a
   * reload, the reload is a request, and the request writes a session file.
   * Measured at six reloads in ten idle seconds.
   */
  test('the watcher ignores what a running application writes', () => {
    const ignored = configured({ input: 'src/main.ts' }).server?.watch.ignored

    expect<string[]>(ignored).toEqual([
      '**/storage/**',
      '**/database/**',
      '**/public/build/**',
      '**/public/hot'
    ])
  })
})

describe('finding the application from the client project', () => {
  test('a client project of its own still writes into the application', async () => {
    const client = join(root, 'frontend')

    await mkdir(client, { recursive: true })

    expect<string>(applicationRoot(client)).toBe(root)
    expect<string>(
      elvel({ input: 'src/main.ts', appDirectory: client }).config({}, { command: 'build' }).build
        .outDir
    ).toBe(join(root, 'public', 'build'))
  })

  test('a config beside `elvel.ts` finds itself', () => {
    expect<string>(applicationRoot(root)).toBe(root)
  })

  /**
   * No application above it: the directory it was given.
   *
   * Better than walking to the filesystem root and writing a hot file at `C:\` or
   * `/`. It is wrong either way, and this way it is wrong somewhere the developer
   * can see.
   */
  test('nothing to find means where it started', async () => {
    const orphan = await mkdtemp(join(tmpdir(), 'elvel-orphan-'))

    try {
      expect<string>(applicationRoot(orphan)).toBe(orphan)
    } finally {
      await rm(orphan, { recursive: true, force: true })
    }
  })
})

/** Vite's dev server, reduced to the three things this plugin touches. */
function fakeServer() {
  const listeners = new Map<string, () => void>()
  const watchers: Array<{ event: string; handler: (file: string) => void }> = []
  const added: string[] = []
  const sent: unknown[] = []

  return {
    added,
    sent,
    listen: () => listeners.get('listening')?.(),
    change: (file: string) => {
      for (const one of watchers) if (one.event === 'change') one.handler(file)
    },
    server: {
      httpServer: {
        once(event: string, handler: () => void) {
          listeners.set(event, handler)
        },
        address: () => ({ port: 5199 })
      },
      watcher: {
        add(paths: string[]) {
          added.push(...paths)
        },
        on(event: string, handler: (file: string) => void) {
          watchers.push({ event, handler })
        }
      },
      hot: {
        send(payload: unknown) {
          sent.push(payload)
        }
      },
      /**
       * What a plugin would have injected into `index.html`.
       *
       * `@vitejs/plugin-react` puts its Fast Refresh preamble here, and
       * `vite-plugin-vue-devtools` its overlay — measured against the official
       * templates, both were being lost.
       */
      transformIndexHtml: async (_url: string, html: string) =>
        html
          .replace(
            '<head>',
            // Prepended, the way React's plugin does it — which is what broke the
            // first attempt at reading these.
            '<head><script type="module">preamble()</script><script type="module" src="/@vite/client"></script>'
          )
          .replace('<body>', '<body><script src="/overlay.js"></script>')
    }
  }
}

describe('the hot file, which is how the server knows Vite is up', () => {
  test('written with the port it actually got, once listening', async () => {
    const fake = fakeServer()
    const plugin = elvel({ input: 'src/main.ts', appDirectory: root })

    plugin.config({}, { command: 'serve' })
    plugin.configureServer(fake.server)

    const path = join(root, 'public', 'hot')

    // Not before: the port is not knowable in advance, and 5173 is a guess that
    // is wrong exactly when a second dev server is running.
    expect<boolean>(await Bun.file(path).exists()).toBe(false)

    fake.listen()

    expect<string>(await Bun.file(path).text()).toBe('http://localhost:5199')
  })
})

describe('reloading the browser for the half of the page Vite never sees', () => {
  test('a view change reloads, a file outside the watched roots does not', () => {
    const fake = fakeServer()
    const plugin = elvel({ input: 'src/main.ts', appDirectory: root })

    plugin.config({}, { command: 'serve' })
    plugin.configureServer(fake.server)

    fake.change(join(root, 'resources', 'views', 'pages', 'welcome.tsx'))

    expect<unknown[]>(fake.sent).toEqual([{ type: 'full-reload', path: '*' }])

    /**
     * The substring bug this guards against: `file.includes('app')` matched
     * `resources/css/app.css` and turned a CSS hot update into a full reload —
     * and matched every file of an application living in `apps/demo`.
     */
    fake.sent.length = 0
    fake.change(join(root, 'resources', 'css', 'app.css'))
    fake.change(join(root, 'appointments', 'thing.ts'))

    expect<number>(fake.sent.length).toBe(0)
  })

  test('the watched roots belong to the application, not the client project', () => {
    const fake = fakeServer()
    const client = join(root, 'frontend')

    const plugin = elvel({ input: 'src/main.ts', appDirectory: client })

    plugin.config({}, { command: 'serve' })
    plugin.configureServer(fake.server)

    expect<boolean>(fake.added.some((path) => path.endsWith('/app'))).toBe(true)
    expect<boolean>(fake.added.every((path) => !path.includes('frontend'))).toBe(true)
  })

  test('`refresh: false` watches nothing at all', () => {
    const fake = fakeServer()
    const plugin = elvel({ input: 'src/main.ts', appDirectory: root, refresh: false })

    plugin.config({}, { command: 'serve' })
    plugin.configureServer(fake.server)

    fake.change(join(root, 'app', 'Models', 'User.ts'))

    expect<string[]>(fake.added).toEqual([])
    expect<number>(fake.sent.length).toBe(0)
  })
})

describe('what the other plugins wanted in the document', () => {
  /**
   * A Vite plugin injects through `transformIndexHtml`, which needs an
   * `index.html` to transform — and an application whose document the server
   * renders has none. Measured against the official templates, that lost the
   * React Fast Refresh preamble and the whole of Vue DevTools.
   *
   * The plugin runs inside Vite, so it asks Vite the same question and writes the
   * answer beside the hot file. Nothing here knows what a preamble is.
   */
  test('are written beside the hot file, for the view to render', async () => {
    const fake = fakeServer()
    const plugin = elvel({ input: 'src/main.ts', appDirectory: root })

    plugin.config({}, { command: 'serve' })
    plugin.configureServer(fake.server)
    fake.listen()

    // The write happens after the transform resolves.
    await Bun.sleep(20)

    const tags = await Bun.file(join(root, 'public', 'hot-tags.txt')).text()

    expect<boolean>(tags.includes('preamble()')).toBe(true)
    expect<boolean>(tags.includes('/overlay.js')).toBe(true)

    /**
     * And `@vite/client` is not among them.
     *
     * It has to come first — it opens the socket everything else reports over — so
     * the view places it, and a second copy here would be a second socket.
     */
    expect<boolean>(tags.includes('@vite/client')).toBe(false)
  })

  test('and nothing is left behind when no plugin wants anything', async () => {
    const fake = fakeServer()

    // A dev server whose plugins inject only Vite's own client.
    fake.server.transformIndexHtml = async (_url: string, html: string) =>
      html.replace('<head>', '<head><script type="module" src="/@vite/client"></script>')

    const plugin = elvel({ input: 'src/main.ts', appDirectory: root })

    plugin.config({}, { command: 'serve' })
    plugin.configureServer(fake.server)
    fake.listen()
    await Bun.sleep(20)

    expect<boolean>(await Bun.file(join(root, 'public', 'hot-tags.txt')).exists()).toBe(false)
  })
})

describe('what a plugin injected during a build', () => {
  /** A page as Vite writes it, and the source it was written from. */
  const source =
    '<!doctype html><html><head><link rel="icon" href="/favicon.svg" /></head>' +
    '<body><script type="module" src="/src/main.tsx"></script></body></html>'

  const built =
    '<!doctype html><html><head><link rel="icon" href="/build/favicon.svg" />' +
    '<script type="module" crossorigin src="/build/assets/main-abc.js"></script>' +
    '<link rel="stylesheet" href="/build/assets/main-def.css">' +
    '<link rel="modulepreload" href="/build/assets/main-abc.js">' +
    '<link rel="manifest" href="/build/manifest.webmanifest">' +
    '</head><body><script id="vite-plugin-pwa:register-sw" src="/build/registerSW.js"></script>' +
    '</body></html>'

  test('is what the source did not have', () => {
    const tags = injectedTags(built, source)

    // `vite-plugin-pwa` injects exactly these two, measured on the react template.
    expect<boolean>(tags.includes('rel="manifest"')).toBe(true)
    expect<boolean>(tags.includes('vite-plugin-pwa:register-sw')).toBe(true)
  })

  /**
   * The template's own tags are not injections, even after a build rewrites them.
   *
   * Comparing whole strings cannot see that: `/favicon.svg` comes back as
   * `/build/favicon.svg`. What survives the rewrite is what the tag *is*.
   */
  test('and not what it had under a different URL', () => {
    expect<boolean>(injectedTags(built, source).includes('favicon')).toBe(false)
  })

  /**
   * A closing tag may carry whitespace before its bracket, and HTML allows it.
   *
   * Vite does not write `</script >`, so nothing was broken — which is exactly why
   * this is worth pinning. A harvester that quietly stops matching when its input
   * gains a space fails as a missing stylesheet three releases later, with nothing
   * pointing back here. CodeQL raised it as a bad tag filter; it is not filtering
   * anything hostile, and the pattern was still wrong.
   */
  test('and a closing tag with anything before its bracket is still one tag', () => {
    const bare = '<!doctype html><html><head></head></html>'

    for (const closing of ['</script>', '</script >', '</script\t\n foo>']) {
      const html =
        '<!doctype html><html><head>' +
        `<script id="injected" src="/build/x.js">${closing}` +
        '<link rel="stylesheet" href="/build/y.css">' +
        '</head></html>'

      const tags = injectedTags(html, bare)

      expect<boolean>(tags.includes('id="injected"')).toBe(true)
      // The script ends where it ends: it has not swallowed the link behind it.
      expect<boolean>(tags.includes(closing)).toBe(true)
    }
  })

  /**
   * And `</scriptfoo>` closes nothing, which is why the pattern uses `\b` and not
   * `[^>]*` alone. The first fix here used `\s*`, caught the space, still missed
   * `</script foo>`, and CodeQL raised the same query a second time.
   */
  test('while a longer tag name does not close the script', () => {
    const html =
      '<!doctype html><html><head>' +
      '<script id="injected" src="/build/x.js"></scriptfoo></script>' +
      '</head></html>'

    const tags = injectedTags(html, '<!doctype html><html><head></head></html>')

    expect<boolean>(tags.includes('</scriptfoo>')).toBe(true)
  })

  /**
   * What Vite adds for an HTML entry is not an injection either.
   *
   * Both name the chunk the view already renders from the manifest — a second
   * stylesheet is a second request for the same bytes, and a preload hint for a
   * script already on the page is noise.
   */
  test('and not the entry Vite wired up itself', () => {
    const tags = injectedTags(built, source)

    expect<boolean>(tags.includes('stylesheet')).toBe(false)
    expect<boolean>(tags.includes('modulepreload')).toBe(false)
    expect<boolean>(tags.includes('main-abc.js')).toBe(false)
  })

  /**
   * Two scans, and both have to find something.
   *
   * One shared global regex made the second `matchAll` start where the first had
   * stopped, so the harvest came back empty against a page with two obvious
   * injections in it. It reads perfectly and is wrong.
   */
  test('scanning the source does not blind the scan of the build', () => {
    expect<boolean>(injectedTags(built, source).length > 0).toBe(true)
    expect<boolean>(injectedTags(built, built).length === 0).toBe(true)
  })
})

describe('the page built only to be read', () => {
  test('is harvested and then not published', async () => {
    const client = join(root, 'frontend')

    await mkdir(client, { recursive: true })
    await writeFile(join(client, 'index.html'), '<html><head></head><body></body></html>')

    const plugin = elvel({ input: 'src/main.ts', appDirectory: client })
    const config = plugin.config({ root: client }, { command: 'build' })

    // The HTML joins the inputs, which is what makes the hook run at all.
    expect<boolean>(JSON.stringify(config.build.rollupOptions.input).includes('index.html')).toBe(
      true
    )

    const out = config.build.outDir

    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'index.html'), 'whatever Vite wrote')

    plugin.writeBundle(
      {},
      {
        'index.html': {
          source:
            '<html><head><link rel="manifest" href="/m.webmanifest"></head><body></body></html>'
        }
      }
    )

    expect<boolean>(await Bun.file(join(out, 'index.html')).exists()).toBe(false)
    expect<string>((await Bun.file(join(out, 'injected-tags.txt')).text()).trim()).toBe(
      '<link rel="manifest" href="/m.webmanifest">'
    )
  })

  /**
   * And the manifest forgets it too.
   *
   * The extra input leaves an `index.html` key naming a file this plugin has just
   * deleted — a puzzle for whoever finds it next.
   */
  test('and the manifest does not name it', async () => {
    const client = join(root, 'frontend')

    await mkdir(client, { recursive: true })
    await writeFile(join(client, 'index.html'), '<html><head></head><body></body></html>')

    const plugin = elvel({ input: 'src/main.ts', appDirectory: client })
    const out = plugin.config({ root: client }, { command: 'build' }).build.outDir

    await mkdir(out, { recursive: true })
    await writeFile(
      join(out, 'manifest.json'),
      JSON.stringify({ 'index.html': { file: 'gone.html' }, 'src/main.ts': { file: 'a.js' } })
    )

    plugin.closeBundle()

    const manifest = (await Bun.file(join(out, 'manifest.json')).json()) as Record<string, unknown>

    expect<string[]>(Object.keys(manifest)).toEqual(['src/main.ts'])
  })
})
