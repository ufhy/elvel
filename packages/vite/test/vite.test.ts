import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import elvel, { applicationRoot } from '../src/index.ts'

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

  test('nothing is copied out of the public directory into its own subdirectory', () => {
    // Vite's own warning otherwise: "The public directory feature may not work
    // correctly. outDir … and publicDir … are not separate folders."
    expect<string | false | undefined>(configured({ input: 'src/main.ts' }).publicDir).toBe(false)
  })

  test('a renamed build directory moves the prefix and the output together', () => {
    const config = configured({ input: 'src/main.ts', buildDirectory: 'assets' })

    expect<string>(config.base).toBe('/assets/')
    expect<string>(config.build.outDir).toBe(join(root, 'public', 'assets'))
    expect<boolean>(config.server.watch.ignored.includes('**/public/assets/**')).toBe(true)
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
    expect<string | false | undefined>(config.publicDir).toBe('static')
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
    const ignored = configured({ input: 'src/main.ts' }).server.watch.ignored

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
      }
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
