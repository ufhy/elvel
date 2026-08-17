import { beforeEach, describe, expect, test } from 'bun:test'
import { CacheServiceProvider } from '@elyvel/cache'
import { Application } from '@elyvel/core'
import { DatabaseServiceProvider } from '@elyvel/database'
import {
  HttpServiceProvider,
  MiddlewareRegistry,
  middleware,
  middlewareNamesOf,
  middlewares,
  signedRoute
} from '@elyvel/http'
import { Elysia } from 'elysia'
import { AuthServiceProvider } from '../src/index.ts'

/**
 * A real application with both providers, so the aliases come from where they
 * come from in an application rather than from a fixture.
 */
async function application(config: Record<string, unknown> = {}): Promise<Application> {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('session', { driver: 'memory', csrf: false })
  // `array` is the in-process store; `memory` is not a driver name.
  app.config.set('cache', { default: 'array', stores: { array: { driver: 'array' } } })
  app.config.set('auth', { mount: false, secret: 'b'.repeat(40), ...config })
  // better-auth is built at boot whatever `mount` says, and building it needs a
  // connection to resolve the dialect from.
  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  await app.register(DatabaseServiceProvider)
  // `throttle` counts in the cache, and says so plainly when there is none.
  await app.register(CacheServiceProvider)
  await app.register(HttpServiceProvider)
  await app.register(AuthServiceProvider)
  await app.boot()

  // What `Application.create()` does at bootstrap. Without it Elysia renders
  // errors its own way and an HttpException's headers — `Retry-After` among them
  // — never reach the response.
  app.handleExceptions()

  return app
}

describe('the registry', () => {
  test('resolves an alias, and says what it knows when it cannot', () => {
    const registry = new MiddlewareRegistry()
    registry.alias('marker', () => () => undefined)

    expect(registry.has('marker')).toBe(true)
    expect(registry.resolve(['marker']).length).toBe(1)
    expect(() => registry.resolve(['nope'])).toThrow(/is not registered.*Known: marker/s)
  })

  test('passes parameters after the first colon', () => {
    const seen: string[][] = []
    const registry = new MiddlewareRegistry()
    registry.alias('spy', (...params) => {
      seen.push(params)

      return () => undefined
    })

    registry.resolve(['spy:update,post', 'spy'])

    // One alias with two parameters, not two aliases.
    expect<string[][]>(seen).toEqual([['update', 'post'], []])
  })

  test('expands a group', () => {
    const registry = new MiddlewareRegistry()
    registry.alias('a', () => () => undefined).alias('b', () => () => undefined)
    registry.group('both', ['a', 'b'])

    expect(registry.resolve(['both']).length).toBe(2)
  })

  test('refuses a group that includes itself', () => {
    const registry = new MiddlewareRegistry()
    registry.group('loop', ['loop'])

    // Without the guard this recurses until the stack gives out, and the error
    // names a frame rather than the group.
    expect(() => registry.resolve(['loop'])).toThrow(/includes itself/)
  })

  /**
   * The case priority exists for.
   *
   * `verified` reads the user that `auth` guarantees. Written the wrong way round
   * it would tell a guest their email is unverified instead of sending them to
   * sign in, so the order is the registry's to fix rather than the caller's to
   * remember.
   */
  test('sorts listed middleware into priority order', () => {
    const order: string[] = []
    const registry = new MiddlewareRegistry()

    for (const name of ['auth', 'verified', 'mine']) {
      registry.alias(name, () => () => {
        order.push(name)

        return undefined
      })
    }
    registry.priority(['auth', 'verified'])

    for (const hook of registry.resolve(['verified', 'mine', 'auth'])) {
      ;(hook as () => void)()
    }

    // Listed ones in their declared order; anything unlisted keeps its place.
    expect<string[]>(order).toEqual(['auth', 'verified', 'mine'])
  })
})

describe('auth and guest, over routes', () => {
  let app: Application

  beforeEach(async () => {
    app = await application()
  })

  function routes() {
    return new Elysia()
      .get('/dashboard', () => 'private', middleware('auth'))
      .get('/sign-in', () => 'form', middleware('guest'))
      .get('/api/me', () => ({ ok: true }), middleware('auth'))
  }

  test('a guest is redirected from a protected page', async () => {
    app.useRoutes(routes())
    const response = await app.handle(new Request('http://localhost/dashboard'))

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/sign-in')
  })

  /**
   * The same failure, rendered the other way.
   *
   * A client that follows redirects would take the sign-in page as the answer to
   * its request, so a JSON-shaped one gets a status and no `Location`.
   */
  test('a JSON caller gets 401 and no location', async () => {
    app.useRoutes(routes())
    const response = await app.handle(
      new Request('http://localhost/api/me', { headers: { accept: 'application/json' } })
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('location')).toBeNull()
  })

  test('a guest reaches a guest-only page', async () => {
    app.useRoutes(routes())
    const response = await app.handle(new Request('http://localhost/sign-in'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('form')
  })

  test('a signed-in visitor is sent away from a guest-only page', async () => {
    app.useRoutes(routes())

    const response = await app
      .make('auth')
      .runWith({ user: { id: '1', email: 'a@b.co' }, session: { id: 'sess-1' } }, () =>
        app.handle(new Request('http://localhost/sign-in'))
      )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/dashboard')
  })

  test('and reaches the protected page', async () => {
    app.useRoutes(routes())

    const response = await app
      .make('auth')
      .runWith({ user: { id: '1', email: 'a@b.co' }, session: { id: 'sess-1' } }, () =>
        app.handle(new Request('http://localhost/dashboard'))
      )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('private')
  })

  test('where guests go is configuration', async () => {
    const configured = await application({ redirectGuestsTo: '/login' })
    configured.useRoutes(new Elysia().get('/x', () => 'x', middleware('auth')))

    expect(
      (await configured.handle(new Request('http://localhost/x'))).headers.get('location')
    ).toBe('/login')
  })
})

describe('verified', () => {
  test('an unverified user is redirected, a verified one passes', async () => {
    const app = await application()
    app.useRoutes(new Elysia().get('/x', () => 'x', middleware('verified')))

    const unverified = await app
      .make('auth')
      .runWith(
        { user: { id: '1', email: 'a@b.co', emailVerified: false }, session: { id: 'sess-1' } },
        () => app.handle(new Request('http://localhost/x'))
      )
    const verified = await app
      .make('auth')
      .runWith(
        { user: { id: '1', email: 'a@b.co', emailVerified: true }, session: { id: 'sess-1' } },
        () => app.handle(new Request('http://localhost/x'))
      )

    expect(unverified.status).toBe(302)
    expect(unverified.headers.get('location')).toBe('/verify-email')
    expect(verified.status).toBe(200)
  })

  /**
   * `verified` alone must not fall open.
   *
   * Laravel's version checks for a user first for exactly this reason: a route
   * that lists only `verified` would otherwise let a guest straight through.
   */
  test('a guest is refused rather than let through', async () => {
    const app = await application()
    app.useRoutes(new Elysia().get('/x', () => 'x', middleware('verified')))

    expect((await app.handle(new Request('http://localhost/x'))).status).toBe(302)
  })

  test('403 rather than a redirect for a JSON caller', async () => {
    const app = await application()
    app.useRoutes(new Elysia().get('/x', () => 'x', middleware('verified')))

    const response = await app.handle(
      new Request('http://localhost/x', { headers: { accept: 'application/json' } })
    )

    // Not 401: with `auth` alongside, the caller may well be authenticated.
    expect(response.status).toBe(403)
  })
})

describe('signed URLs', () => {
  test('a signed route passes and a tampered one does not', async () => {
    const app = await application()
    app.make('routes').name('unsub', '/unsub')
    app.useRoutes(new Elysia().get('/unsub', () => 'gone', middleware('signed')))

    const signed = await app.handle(new Request(signedRoute('unsub', { list: '7' })))
    const tampered = await app.handle(
      new Request(signedRoute('unsub', { list: '7' }).replace('list=7', 'list=8'))
    )

    expect(signed.status).toBe(200)
    // Changing a parameter must invalidate it, which is the whole point.
    expect(tampered.status).toBe(403)
  })

  test('an expired signature is refused', async () => {
    const app = await application()
    app.make('routes').name('invite', '/invite')
    app.useRoutes(new Elysia().get('/invite', () => 'in', middleware('signed')))

    const url = signedRoute('invite', {}, -1)

    expect((await app.handle(new Request(url))).status).toBe(403)
  })

  test('parameter order does not change the signature', async () => {
    const app = await application()
    app.make('routes').name('two', '/two')
    app.useRoutes(new Elysia().get('/two', () => 'ok', middleware('signed')))

    const url = new URL(signedRoute('two', { a: '1', b: '2' }))
    const signature = url.searchParams.get('signature') as string

    // Rebuilt with the parameters the other way round; a proxy may do this.
    const reordered = `${url.origin}${url.pathname}?b=2&a=1&signature=${signature}`

    expect((await app.handle(new Request(reordered))).status).toBe(200)
  })

  test('an unsigned request is refused', async () => {
    const app = await application()
    app.useRoutes(new Elysia().get('/bare', () => 'ok', middleware('signed')))

    expect((await app.handle(new Request('http://localhost/bare'))).status).toBe(403)
  })
})

describe('throttle as an alias', () => {
  test('refuses once the window is used up', async () => {
    const app = await application()
    app.useRoutes(new Elysia().get('/ping', () => 'pong', middleware('throttle:2,1')))

    const first = await app.handle(new Request('http://localhost/ping'))

    const second = await app.handle(new Request('http://localhost/ping'))
    const third = await app.handle(new Request('http://localhost/ping'))

    expect([first.status, second.status]).toEqual([200, 200])
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).not.toBeNull()
  })
})

describe('several at once', () => {
  test('the whole set runs, and the first refusal wins', async () => {
    const app = await application()
    let reached = false

    app.useRoutes(
      new Elysia().get(
        '/x',
        () => {
          reached = true

          return 'x'
        },
        middleware('auth', 'verified')
      )
    )

    const response = await app.handle(new Request('http://localhost/x'))

    // `auth` refuses first, so `verified` never runs and neither does the handler.
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/sign-in')
    expect(reached).toBe(false)
  })

  test('a group applies to every route inside it', async () => {
    const app = await application()

    app.useRoutes(
      new Elysia().guard(middleware('auth'), (routes) =>
        routes.get('/a', () => 'a').get('/b', () => 'b')
      )
    )

    expect((await app.handle(new Request('http://localhost/a'))).status).toBe(302)
    expect((await app.handle(new Request('http://localhost/b'))).status).toBe(302)
  })

  test('a registered group name resolves', async () => {
    const app = await application()
    middlewares().group('dashboard', ['auth', 'verified'])

    app.useRoutes(new Elysia().get('/x', () => 'x', middleware('dashboard')))

    expect((await app.handle(new Request('http://localhost/x'))).status).toBe(302)
  })
})

/**
 * Three ways to change what a built-in middleware does.
 *
 * Laravel offers the same three — `redirectTo()` with a string or a callable,
 * re-aliasing a name, and `replace()` — and the callable is the one that matters:
 * an admin area sends a guest somewhere else, which no fixed string expresses.
 */
describe('customising a built-in middleware', () => {
  test('1. a config string changes where it sends people', async () => {
    const app = await application({ redirectGuestsTo: '/login' })
    app.useRoutes(new Elysia().get('/x', () => 'x', middleware('auth')))

    expect((await app.handle(new Request('http://localhost/x'))).headers.get('location')).toBe(
      '/login'
    )
  })

  test('2. a callable decides per request', async () => {
    const app = await application({
      redirectGuestsTo: (request: Request) =>
        new URL(request.url).pathname.startsWith('/admin') ? '/admin/login' : '/sign-in'
    })

    app.useRoutes(
      new Elysia()
        .get('/admin/panel', () => 'x', middleware('auth'))
        .get('/profile', () => 'x', middleware('auth'))
    )

    const admin = await app.handle(new Request('http://localhost/admin/panel'))
    const profile = await app.handle(new Request('http://localhost/profile'))

    expect(admin.headers.get('location')).toBe('/admin/login')
    expect(profile.headers.get('location')).toBe('/sign-in')
  })

  test('3. re-aliasing the name replaces it outright', async () => {
    const app = await application()

    // An application provider registers after the framework's, so the last
    // registration wins — which is what makes this an override rather than a
    // collision.
    middlewares().alias('auth', () => () => new Response('mine', { status: 418 }))
    app.useRoutes(new Elysia().get('/x', () => 'x', middleware('auth')))

    const response = await app.handle(new Request('http://localhost/x'))

    expect(response.status).toBe(418)
    expect(await response.text()).toBe('mine')
  })

  test('and the guest middleware honours a callable too', async () => {
    const app = await application({
      redirectUsersTo: (request: Request) =>
        new URL(request.url).searchParams.has('next') ? '/next' : '/dashboard'
    })

    app.useRoutes(new Elysia().get('/sign-in', () => 'form', middleware('guest')))

    const withNext = await app
      .make('auth')
      .runWith({ user: { id: '1', email: 'a@b.co' }, session: { id: 's' } }, () =>
        app.handle(new Request('http://localhost/sign-in?next=1'))
      )

    expect(withNext.headers.get('location')).toBe('/next')
  })
})

describe('seeing what is registered', () => {
  test('names() reports aliases and groups together', async () => {
    await application()
    const registry = middlewares()

    // What `middleware:list` prints, and the only answer to "what may I write on
    // a route?" — the aliases come from whichever packages are installed.
    expect(registry.names()).toContain('auth')
    expect(registry.names()).toContain('throttle')
    expect(registry.names()).toContain('signed')

    registry.group('locked', ['auth', 'verified'])

    expect(registry.names()).toContain('locked')
    expect<string[] | undefined>(registry.expands('locked')).toEqual(['auth', 'verified'])
    // A plain alias expands to nothing, which is how the two are told apart.
    expect(registry.expands('auth')).toBeUndefined()
  })

  test('a route carries the names it was declared with', async () => {
    const app = await application()
    app.useRoutes(new Elysia().get('/x', () => 'x', middleware('auth', 'throttle:6,1')))

    const route = app.router.routes.find((one) => one.path === '/x')

    // Elysia compiles hooks into an anonymous chain, so the names are read back
    // off the function rather than from the route table — which is what lets
    // `route:list` print a column instead of a shrug.
    expect<string[]>(middlewareNamesOf(route)).toEqual(['auth', 'throttle:6,1'])
  })
})
