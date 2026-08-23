import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '@elvel/core'
import { HttpServiceProvider } from '@elvel/http'
import { ViewServiceProvider } from '@elvel/view'
import { Elysia } from 'elysia'
import { SpaServiceProvider } from '../src/provider.ts'
import { document, spa } from '../src/spa.ts'

let root: string

/**
 * A real application, because what is being tested is which requests get a
 * document and what the document contains.
 */
async function application(spaConfig: Record<string, unknown> = {}): Promise<Application> {
  const app = new Application(root)

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', 'testing')
  app.config.set('session', { driver: 'memory' })
  app.config.set('view', { serveStatic: false })
  app.config.set('spa', { entry: 'src/main.ts', title: 'Invoices', ...spaConfig })

  await app.register(HttpServiceProvider)
  await app.register(ViewServiceProvider)
  await app.register(SpaServiceProvider)
  await app.boot()

  app.handleExceptions()

  return app
}

/** A page asking for HTML, the way a browser does. */
const asBrowser = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { accept: 'text/html,*/*;q=0.8' } })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-spa-'))

  // A built client, so `vite()` has a manifest to read.
  await mkdir(join(root, 'public', 'build'), { recursive: true })
  await writeFile(
    join(root, 'public', 'build', 'manifest.json'),
    JSON.stringify({
      'src/main.ts': { file: 'assets/main-abc.js', css: ['assets/main-def.css'], isEntry: true }
    })
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the document', () => {
  test('carries the payload, the token and the asset tags', async () => {
    const app = await application()

    spa().payload(() => ({ user: { name: 'Ada' } }))

    app.useRoutes(new Elysia().get('/', () => document()))

    const response = await app.handle(asBrowser('/'))
    const html = await response.text()

    expect<number>(response.status).toBe(200)
    expect<boolean>(html.includes('<!DOCTYPE html>')).toBe(true)
    expect<boolean>(html.includes('/build/assets/main-abc.js')).toBe(true)
    expect<boolean>(html.includes('/build/assets/main-def.css')).toBe(true)
    expect<boolean>(html.includes('<title>Invoices</title>')).toBe(true)
    expect<boolean>(html.includes('<div id="app">')).toBe(true)

    const payload = JSON.parse(
      /id="page-data">(.*?)<\/script>/s.exec(html)?.[1]?.replaceAll('\\u003c', '<') ?? '{}'
    ) as { user?: { name: string }; csrf?: string }

    expect<string | undefined>(payload.user?.name).toBe('Ada')

    /**
     * The token is added here, not by the application.
     *
     * Forgetting it is not a visible mistake: the page renders, and the first
     * write comes back 419 from somewhere else entirely.
     */
    expect<number>((payload.csrf ?? '').length).toBeGreaterThan(0)
  })

  /**
   * `no-store`, because this document is one person's.
   *
   * It names hashed assets *and* carries a session's data, so a shared cache
   * holding it could hand one person's payload to the next.
   */
  test('is never stored when it carries a payload', async () => {
    const app = await application()

    app.useRoutes(new Elysia().get('/', () => document()))

    expect<string | null>((await app.handle(asBrowser('/'))).headers.get('cache-control')).toBe(
      'no-store'
    )
  })

  test('a page can add to the payload and change the title', async () => {
    const app = await application()

    spa().payload(() => ({ user: null }))

    app.useRoutes(
      new Elysia().get('/', () => document({ title: 'Sign in', payload: { next: '/dashboard' } }))
    )

    const html = await (await app.handle(asBrowser('/'))).text()

    expect<boolean>(html.includes('<title>Sign in</title>')).toBe(true)
    expect<boolean>(html.includes('/dashboard')).toBe(true)
  })
})

describe('a shell, for an application that has to be cacheable', () => {
  /**
   * Nothing per-person in the bytes: no payload and no token.
   *
   * A token is per session, so a shell carrying one would be per session too — and
   * a document that differs per person is a document no cache may keep, which is
   * the whole reason to choose a shell.
   */
  test('embeds nothing at all', async () => {
    const app = await application({ embed: false })

    spa().payload(() => ({ user: { name: 'Ada' } }))

    app.useRoutes(new Elysia().get('/', () => document()))

    const response = await app.handle(asBrowser('/'))
    const html = await response.text()

    expect<boolean>(html.includes('page-data')).toBe(false)
    expect<boolean>(html.includes('Ada')).toBe(false)
    expect<boolean>(html.includes('/build/assets/main-abc.js')).toBe(true)
    expect<string | null>(response.headers.get('cache-control')).not.toBe('no-store')
  })
})

describe('the addresses only the client router knows', () => {
  /**
   * The reason this package replaces the exception handler at all.
   *
   * `/invoices/9` is not missing — the client owns it — and a reload on it has to
   * boot the same application from the same data.
   */
  test('a deep link gets the same document as the front page', async () => {
    const app = await application()

    spa().payload(() => ({ user: { name: 'Ada' } }))

    app.useRoutes(new Elysia().get('/', () => document()))

    const front = await (await app.handle(asBrowser('/'))).text()
    const deep = await app.handle(asBrowser('/invoices/9'))

    expect<number>(deep.status).toBe(200)

    const html = await deep.text()

    expect<boolean>(html.includes('Ada')).toBe(true)
    expect<boolean>(html.includes('/build/assets/main-abc.js')).toBe(true)

    // Same renderer, so the two cannot disagree about what the application boots
    // with — the bug that only shows up on reload.
    expect<boolean>(
      html.replace(/"csrf":"[^"]+"/, '') === front.replace(/"csrf":"[^"]+"/, '')
    ).toBe(true)
  })

  test('a client asking for JSON keeps its 404', async () => {
    const app = await application()

    const response = await app.handle(
      new Request('http://localhost/nowhere', { headers: { accept: 'application/json' } })
    )

    expect<number>(response.status).toBe(404)
    expect<string | null>(response.headers.get('content-type')).toContain('application/json')
  })

  test('an API path keeps its 404 even for a browser', async () => {
    const app = await application()

    expect<number>((await app.handle(asBrowser('/api/nothing'))).status).toBe(404)
  })

  /**
   * A missing file stays missing.
   *
   * A stale `/build/assets/index-abc123.js` from a cached document, a deleted
   * image — answering the document there hides the mistake behind a page that
   * renders.
   */
  test('anything with an extension keeps its 404', async () => {
    const app = await application()

    expect<number>((await app.handle(asBrowser('/build/assets/gone-abc123.js'))).status).toBe(404)
    expect<number>((await app.handle(asBrowser('/logo.png'))).status).toBe(404)
  })

  test('a write to an address nothing serves is not a page', async () => {
    const app = await application()

    const response = await app.handle(
      new Request('http://localhost/invoices', {
        method: 'POST',
        headers: { accept: 'text/html' }
      })
    )

    expect<boolean>(response.status === 200).toBe(false)
  })

  /** And a real error is still a real error, not a document. */
  test('a 500 is not answered with the application', async () => {
    const app = await application()

    app.useRoutes(
      new Elysia().get('/boom', () => {
        throw new Error('the database is on fire')
      })
    )

    const response = await app.handle(asBrowser('/boom'))

    expect<number>(response.status).toBe(500)
    expect<boolean>((await response.text()).includes('page-data')).toBe(false)
  })
})
