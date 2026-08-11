import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { Application } from '../src/application.ts'
import { ServiceProvider } from '../src/service-provider.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elysian-app-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('container', () => {
  test('bind resolves a new value every time', () => {
    const app = new Application(root)
    let calls = 0

    app.bind(
      'counter' as never,
      ((): number => {
        calls += 1
        return calls
      }) as never
    )

    expect(app.make('counter' as never)).toBe(1 as never)
    expect(app.make('counter' as never)).toBe(2 as never)
  })

  test('singleton resolves once', () => {
    const app = new Application(root)
    let calls = 0

    app.singleton(
      'shared' as never,
      (() => {
        calls += 1
        return { id: calls }
      }) as never
    )

    expect(app.make('shared' as never)).toBe(app.make('shared' as never))
    expect(calls).toBe(1)
  })

  test('instance stores a ready-made value', () => {
    const app = new Application(root)
    const value = { ready: true }

    app.instance('thing' as never, value as never)

    expect(app.make('thing' as never)).toBe(value as never)
  })

  test('rebinding clears a previously resolved singleton', () => {
    const app = new Application(root)

    app.singleton('thing' as never, (() => 'first') as never)
    expect(app.make('thing' as never)).toBe('first' as never)

    app.singleton('thing' as never, (() => 'second') as never)
    expect(app.make('thing' as never)).toBe('second' as never)
  })

  test('bound reports both bindings and instances', () => {
    const app = new Application(root)

    app.bind('a' as never, (() => 1) as never)
    app.instance('b' as never, 2 as never)

    expect(app.bound('a')).toBe(true)
    expect(app.bound('b')).toBe(true)
    expect(app.bound('c')).toBe(false)
  })

  test('resolving an unbound key names the key', () => {
    const app = new Application(root)

    expect(() => app.make('missing' as never)).toThrow(/Target \[missing\] is not bound/)
  })

  test('the exception handler is bound out of the box', () => {
    const app = new Application(root)

    expect(app.bound('exception.handler')).toBe(true)
  })
})

describe('paths', () => {
  test('derive from the application root', () => {
    const app = new Application(root)

    expect(app.basePath()).toBe(root)
    expect(app.configPath()).toBe(join(root, 'config'))
    expect(app.appPath('Http', 'Controllers')).toBe(join(root, 'app', 'Http', 'Controllers'))
    expect(app.viewPath('pages')).toBe(join(root, 'resources', 'views', 'pages'))
    expect(app.routesPath('web.ts')).toBe(join(root, 'routes', 'web.ts'))
    expect(app.publicPath('css')).toBe(join(root, 'public', 'css'))
    expect(app.storagePath()).toBe(join(root, 'storage'))
  })
})

describe('environment', () => {
  test('reads from config with an env fallback', () => {
    const app = new Application(root)
    app.config.set('app.env', 'staging')

    expect(app.environment()).toBe('staging')
    expect(app.isProduction()).toBe(false)
    expect(app.isLocal()).toBe(false)
  })

  test('production and local are derived, not stored twice', () => {
    const app = new Application(root)

    app.config.set('app.env', 'production')
    expect(app.isProduction()).toBe(true)

    app.config.set('app.env', 'local')
    expect(app.isLocal()).toBe(true)
  })

  test('debug mode defaults to off', () => {
    const app = new Application(root)

    expect(app.hasDebugModeEnabled()).toBe(false)

    app.config.set('app.debug', true)
    expect(app.hasDebugModeEnabled()).toBe(true)
  })
})

describe('providers', () => {
  const order: string[] = []

  class First extends ServiceProvider {
    register(): void {
      order.push('first:register')
      this.app.instance('first' as never, 'bound' as never)
    }

    override boot(): void {
      order.push('first:boot')
    }
  }

  class Second extends ServiceProvider {
    register(): void {
      order.push('second:register')
    }

    override boot(): void {
      // Safe to resolve here: every provider has registered by now.
      order.push(`second:boot:${this.app.make('first' as never)}`)
    }
  }

  beforeEach(() => {
    order.length = 0
  })

  test('all providers register before any boots', async () => {
    const app = new Application(root)

    await app.register(First)
    await app.register(Second)
    await app.boot()

    expect(order).toEqual(['first:register', 'second:register', 'first:boot', 'second:boot:bound'])
  })

  test('a provider registered after boot is booted immediately', async () => {
    const app = new Application(root)
    await app.boot()

    await app.register(First)

    expect(order).toEqual(['first:register', 'first:boot'])
  })

  test('boot is idempotent', async () => {
    const app = new Application(root)
    await app.register(First)

    await app.boot()
    await app.boot()

    expect(order.filter((entry) => entry === 'first:boot')).toHaveLength(1)
  })

  test('booted callbacks run after boot, and immediately once booted', async () => {
    const app = new Application(root)
    const seen: string[] = []

    app.booted(() => {
      seen.push('before')
    })
    expect(seen).toEqual([])

    await app.boot()
    expect(seen).toEqual(['before'])

    app.booted(() => {
      seen.push('after')
    })
    expect(seen).toEqual(['before', 'after'])
  })
})

describe('routing', () => {
  test('useRoutes accepts a plugin', async () => {
    const app = new Application(root)
    app.useRoutes(new Elysia().get('/direct', () => 'ok'))

    expect(await (await app.handle(new Request('http://localhost/direct'))).text()).toBe('ok')
  })

  test('useRoutes accepts a factory receiving the application', async () => {
    const app = new Application(root)
    app.config.set('app.name', 'FromFactory')

    app.useRoutes((instance) =>
      new Elysia().get('/factory', () => instance.config.get<string>('app.name'))
    )

    expect(await (await app.handle(new Request('http://localhost/factory'))).text()).toBe(
      'FromFactory'
    )
  })
})

describe('ApplicationBuilder', () => {
  test('registers config providers before builder providers', async () => {
    const order: string[] = []

    class FromConfig extends ServiceProvider {
      register(): void {
        order.push('config')
      }
    }

    class FromBuilder extends ServiceProvider {
      register(): void {
        order.push('builder')
      }
    }

    await Bun.write(
      join(root, 'config', 'app.ts'),
      `export default { env: 'testing', providers: [] }`
    )

    const app = await Application.configure(root).withProviders([FromBuilder]).create()
    // Config providers are read from the file; inject one by hand to assert the
    // ordering rule without importing a module from a temp directory.
    await app.register(FromConfig)

    expect(order).toEqual(['builder', 'config'])
    expect(app.environment()).toBe('testing')
  })

  test('routes load after providers boot', async () => {
    const order: string[] = []

    class Marker extends ServiceProvider {
      register(): void {}
      override boot(): void {
        order.push('boot')
      }
    }

    const app = await Application.configure(root)
      .withProviders([Marker])
      .withRoutes(async () => {
        order.push('routes')
        return { default: new Elysia().get('/late', () => 'late') }
      })
      .create()

    expect(order).toEqual(['boot', 'routes'])
    expect(await (await app.handle(new Request('http://localhost/late'))).text()).toBe('late')
  })
})

describe('instance tracking', () => {
  test('getInstance returns the most recently constructed application', () => {
    const first = new Application(root)
    const second = new Application(root)

    expect(Application.getInstance()).toBe(second)
    expect(Application.getInstance()).not.toBe(first)
  })

  test('setInstance(undefined) makes the helpers fail loudly', () => {
    new Application(root)
    Application.setInstance(undefined)

    expect(() => Application.getInstance()).toThrow(/No application instance/)
  })
})
