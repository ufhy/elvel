import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application } from '@elysian/core'

const FIXTURE = join(import.meta.dir, 'fixture')

let app: Application

beforeAll(async () => {
  app = await Application.configure(FIXTURE)
    .withRoutes(() => import('./fixture/routes/web.ts'))
    .create()
})

describe('bootstrap', () => {
  test('loads config files as namespaces', () => {
    expect(app.config.get<string>('app.name')).toBe('Fixture')
    expect(app.config.get<boolean>('view.cache')).toBe(false)
    expect(app.config.get('app.missing', 'fallback')).toBe('fallback')
  })

  test('exposes the environment', () => {
    expect(app.environment()).toBe('testing')
    expect(app.isProduction()).toBe(false)
    expect(app.hasDebugModeEnabled()).toBe(true)
  })

  test('resolves paths from the application root', () => {
    expect(app.viewPath()).toBe(join(FIXTURE, 'resources', 'views'))
    expect(app.publicPath('robots.txt')).toBe(join(FIXTURE, 'public', 'robots.txt'))
  })

  test('boots providers listed in config/app.ts', () => {
    expect(app.bound('view')).toBe(true)
    expect(app.bound('artisan')).toBe(true)
  })

  test('container distinguishes bind from singleton', () => {
    let calls = 0

    app.bind(
      'counter' as never,
      (() => {
        calls += 1
        return calls
      }) as never
    )
    app.make('counter' as never)
    app.make('counter' as never)
    expect(calls).toBe(2)

    app.singleton('shared' as never, (() => ({ id: Math.random() })) as never)
    expect(app.make('shared' as never)).toBe(app.make('shared' as never))
  })

  test('unbound keys throw', () => {
    expect(() => app.make('nope' as never)).toThrow(/not bound/)
  })
})

describe('http', () => {
  test('renders a JSX view through the layout component', async () => {
    const response = await app.handle(new Request('http://localhost/'))
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // JSX has no doctype node — the renderer prepends it for full documents
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<title>Greeting</title>')
    expect(html).toContain('<h1>Hello World</h1>')
    expect(html).toContain('<li>a</li>')
    // A layout reads shared values by importing config(), not via template scope
    expect(html).toContain('Fixture/testing')
  })

  test('the safe attribute escapes interpolated input', async () => {
    const html = await (await app.handle(new Request('http://localhost/escaped'))).text()

    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  test('components without required props render', async () => {
    const html = await (await app.handle(new Request('http://localhost/bare'))).text()

    expect(html).toBe('<p>no props</p>')
    // Not a full document, so no doctype is prepended
    expect(html.startsWith('<!DOCTYPE')).toBe(false)
  })

  test('render() returns markup as a string', async () => {
    const body = (await (await app.handle(new Request('http://localhost/string'))).json()) as {
      html: string
    }

    expect(body.html).toBe('<p>no props</p>')
  })

  test('returns JSON for plain object handlers', async () => {
    const response = await app.handle(new Request('http://localhost/json'))

    expect(await response.json()).toEqual({ ok: true })
  })

  test('serves static files from public/', async () => {
    const response = await app.handle(new Request('http://localhost/robots.txt'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('User-agent: *')
  })

  test('HttpException carries its own status', async () => {
    const response = await app.handle(new Request('http://localhost/boom'))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: 'No such thing' })
  })

  test('unexpected errors render as 500', async () => {
    const response = await app.handle(new Request('http://localhost/explode'))

    expect(response.status).toBe(500)
    // debug is on in the fixture, so the real message and stack come through
    expect(await response.json()).toMatchObject({ message: 'kaboom', exception: 'Error' })
  })

  test('unknown paths render a humanised 404', async () => {
    const response = await app.handle(new Request('http://localhost/missing-page'))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: 'Not Found' })
  })
})

describe('console', () => {
  test('registers framework commands', () => {
    const names = app
      .make('artisan')
      .all()
      .map((command) => command.signature.split(' ')[0])

    expect(names).toContain('serve')
    expect(names).toContain('route:list')
    expect(names).toContain('about')
    expect(names).toContain('make:controller')
  })

  test('unknown commands exit non-zero', async () => {
    expect(await app.make('artisan').run(['does:not-exist'])).toBe(1)
  })

  test('route:list succeeds against the real route table', async () => {
    expect(await app.make('artisan').run(['route:list', '--method', 'GET'])).toBe(0)
  })
})
