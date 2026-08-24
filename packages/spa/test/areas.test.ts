import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '@elvel/core'
import { HttpServiceProvider, redirect } from '@elvel/http'
import { ViewServiceProvider } from '@elvel/view'
import { SpaServiceProvider } from '../src/provider.ts'

/**
 * Areas — one shell per region of the application, with its own guard.
 *
 * The shape Laravel writes as `Route::view('{path}', 'main')->middleware('auth')`
 * beside `Route::view('/auth/{path}', 'auth')->middleware('guest')`. Two things are
 * being declared: which bundle an address belongs to, and who may ask for it.
 */
let root: string

async function application(spaConfig: Record<string, unknown> = {}): Promise<Application> {
  const app = new Application(root)

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', 'testing')
  app.config.set('session', { driver: 'memory' })
  app.config.set('view', { serveStatic: false })
  app.config.set('spa', { entry: 'src/main.ts', title: 'Invoices', embed: false, ...spaConfig })

  await app.register(HttpServiceProvider)

  /**
   * Aliased through this application's own registry, after the provider bound it.
   *
   * Two guards that need no better-auth: one refuses everything, one waves it
   * through. Registered before boot, because the provider mounts the area routes
   * there and resolves the names as it does.
   */
  const registry = app.make('middleware')
  registry.alias('closed', () => () => redirect('/refused').toResponse())
  registry.alias('open', () => () => undefined)
  registry.alias('throws', () => () => {
    throw new Error('no')
  })

  await app.register(ViewServiceProvider)
  await app.register(SpaServiceProvider)
  await app.boot()

  app.handleExceptions()

  return app
}

const asBrowser = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { accept: 'text/html,*/*;q=0.8' } })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-areas-'))

  await mkdir(join(root, 'public', 'build'), { recursive: true })
  /**
   * Both entries, and the CSS — the same manifest `spa.test.ts` writes.
   *
   * Two applications in one process share `Application.current`, which is what
   * `vite()` resolves through. So whichever of these files created the newest
   * application is the one whose manifest gets read, and a manifest that names
   * fewer entries than the other silently drops assets from the other file's
   * assertions. Keeping them identical is the cheap half of that; the expensive
   * half would be making the framework support two live applications, which it
   * documents that it does not.
   */
  await writeFile(
    join(root, 'public', 'build', 'manifest.json'),
    JSON.stringify({
      'src/main.ts': { file: 'assets/main-abc.js', css: ['assets/main-def.css'], isEntry: true },
      'src/auth.ts': { file: 'assets/auth-def.js', isEntry: true }
    })
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('with no areas declared', () => {
  test('the document is exactly what it was — one entry, no guard', async () => {
    const app = await application()

    const response = await app.handle(asBrowser('/anything/at/all'))
    const html = await response.text()

    expect<number>(response.status).toBe(200)
    expect<boolean>(html.includes('/build/assets/main-abc.js')).toBe(true)
    expect<boolean>(html.includes('<title>Invoices</title>')).toBe(true)
  })
})

describe('a prefixed area', () => {
  const areas = [
    { path: '/auth', entry: 'src/auth.ts', title: 'Sign in', middleware: ['open'] },
    { path: '/', entry: 'src/main.ts', middleware: ['open'] }
  ]

  test('serves its own entry, and the root area serves the other', async () => {
    const app = await application({ areas })

    const auth = await (await app.handle(asBrowser('/auth/login'))).text()
    const main = await (await app.handle(asBrowser('/dashboard'))).text()

    // The point of declaring areas at all: a guest downloads the auth bundle and
    // not the application behind it.
    expect<boolean>(auth.includes('/build/assets/auth-def.js')).toBe(true)
    expect<boolean>(auth.includes('<title>Sign in</title>')).toBe(true)

    expect<boolean>(main.includes('/build/assets/main-abc.js')).toBe(true)
  })

  test('owns its bare prefix too, which is a second route', async () => {
    const app = await application({ areas })

    /**
     * `/auth/*` does not match `/auth`. Without the pair, an area's own front door
     * falls through to the root shell — which is why Laravel's version writes
     * `Route::view('{any}', …)` and `Route::view('', …)` beside each other.
     */
    const html = await (await app.handle(asBrowser('/auth'))).text()

    expect<boolean>(html.includes('/build/assets/auth-def.js')).toBe(true)
  })

  test('and does not own a path that merely starts with its name', async () => {
    const app = await application({ areas })

    const html = await (await app.handle(asBrowser('/authors/9'))).text()

    expect<boolean>(html.includes('/build/assets/main-abc.js')).toBe(true)
  })
})

describe('the guard', () => {
  test('applies to a prefixed area, through its route', async () => {
    const app = await application({
      areas: [{ path: '/admin', entry: 'src/main.ts', middleware: ['closed'] }]
    })

    for (const path of ['/admin', '/admin/users']) {
      const response = await app.handle(asBrowser(path))

      expect<number>(response.status).toBe(302)
      expect<string | null>(response.headers.get('location')).toBe('/refused')
    }
  })

  test('applies to the root area, which has no route to carry it', async () => {
    /**
     * The one that cannot be a route: a `GET /*` loses to the static file plugin in
     * development. So the exception handler runs the middleware itself — without
     * that, every address the client router owns is open to anybody.
     */
    const app = await application({ areas: [{ path: '/', middleware: ['closed'] }] })

    const response = await app.handle(asBrowser('/dashboard'))

    expect<number>(response.status).toBe(302)
    expect<string | null>(response.headers.get('location')).toBe('/refused')
  })

  test('and a throwing guard is rendered, not left to climb the error pipeline', async () => {
    const app = await application({ areas: [{ path: '/', middleware: ['throws'] }] })

    // This handler is already inside the error pipeline; a throw would re-enter it.
    expect<number>((await app.handle(asBrowser('/dashboard'))).status).toBe(500)
  })
})
