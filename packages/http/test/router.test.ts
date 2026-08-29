import { afterEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { t } from 'elysia'
import { compileRoutes } from '../src/router/compile.ts'
import { currentRouteName, currentRouteNamed, currentRouteUri } from '../src/router/current.ts'
import { Route, resetRouter } from '../src/router/registrar.ts'
import { RouteRegistry } from '../src/routes.ts'

/**
 * The `Route` facade, checked against the behaviour Laravel's own tests pin down.
 *
 * Each `describe` names the test in `Illuminate\Tests\Routing` it came from, so a
 * difference can be looked up rather than argued about. Where this framework
 * cannot match Laravel — constraints filter after matching rather than during it
 * — the test says so and asserts what does happen.
 */
afterEach(() => {
  resetRouter()
})

/**
 * A fresh application, because names and middleware are resolved through one.
 *
 * The name table is bound here rather than by `HttpServiceProvider`: these tests
 * are about the router, and booting the whole provider stack to name a route
 * would make a failure ambiguous about which layer broke.
 */
function boot(): Application {
  const app = new Application(process.cwd())

  app.config.set('app.env', 'testing')
  app.instance('routes', new RouteRegistry())

  return app
}

async function call(
  instance: ReturnType<typeof compileRoutes>,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return instance.handle(new Request(`http://localhost${path}`, init))
}

describe('the verbs — testCanRegisterGetRouteWithClosureAction', () => {
  test('each one answers its own method and nothing else', async () => {
    boot()

    Route.get('/g', () => 'got')
    Route.post('/p', () => 'posted')
    Route.put('/u', () => 'put')
    Route.patch('/a', () => 'patched')
    Route.delete('/d', () => 'deleted')

    const routes = compileRoutes('verbs')

    expect<string>(await (await call(routes, '/g')).text()).toBe('got')
    expect<string>(await (await call(routes, '/p', { method: 'POST' })).text()).toBe('posted')
    expect<string>(await (await call(routes, '/u', { method: 'PUT' })).text()).toBe('put')
    expect<string>(await (await call(routes, '/a', { method: 'PATCH' })).text()).toBe('patched')
    expect<string>(await (await call(routes, '/d', { method: 'DELETE' })).text()).toBe('deleted')

    expect<number>((await call(routes, '/g', { method: 'POST' })).status).toBe(404)
  })

  test('any answers every verb — testCanRegisterAnyRouteWithClosureAction', async () => {
    boot()

    Route.any('/thing', () => 'anything')

    const routes = compileRoutes('any')

    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect<string>(await (await call(routes, '/thing', { method })).text()).toBe('anything')
    }
  })

  test('match answers only the listed verbs — testCanRegisterMatchRouteWithClosureAction', async () => {
    boot()

    Route.match(['get', 'post'], '/two', () => 'matched')

    const routes = compileRoutes('match')

    expect<string>(await (await call(routes, '/two')).text()).toBe('matched')
    expect<string>(await (await call(routes, '/two', { method: 'POST' })).text()).toBe('matched')
    expect<number>((await call(routes, '/two', { method: 'PUT' })).status).toBe(404)
  })
})

describe('parameters', () => {
  test('a required one arrives, an optional one may not', async () => {
    boot()

    Route.get(
      '/users/{id}',
      ({ params }: { params: Record<string, string> }) => `user ${params.id}`
    )
    Route.get(
      '/posts/{id?}',
      ({ params }: { params: Record<string, string> }) => `post ${params.id ?? 'none'}`
    )

    const routes = compileRoutes('params')

    expect<string>(await (await call(routes, '/users/9')).text()).toBe('user 9')
    expect<string>(await (await call(routes, '/posts/4')).text()).toBe('post 4')
    expect<string>(await (await call(routes, '/posts')).text()).toBe('post none')
  })

  test('defaults fill a parameter the URI did not carry — Route::defaults', async () => {
    boot()

    Route.get(
      '/reports/{format?}',
      ({ params }: { params: Record<string, string> }) => `as ${params.format}`
    ).defaults('format', 'pdf')

    const routes = compileRoutes('defaults')

    expect<string>(await (await call(routes, '/reports')).text()).toBe('as pdf')
    expect<string>(await (await call(routes, '/reports/csv')).text()).toBe('as csv')
  })
})

/**
 * `testWherePatternsProperlyFilter`, and the one place this framework differs.
 *
 * In Laravel a constraint is part of matching, so `/users/{id}` constrained to
 * digits and `/users/{slug}` can coexist. Elysia's radix router matches once and
 * cannot fall through, so a failed constraint is a 404 here. Asserted rather than
 * hidden.
 */
describe('constraints', () => {
  test('where filters what reaches the handler', async () => {
    boot()

    Route.get('/users/{id}', () => 'user').where('id', '[0-9]+')

    const routes = compileRoutes('where')

    expect<number>((await call(routes, '/users/9')).status).toBe(200)
    expect<number>((await call(routes, '/users/abc')).status).toBe(404)
  })

  test('the shorthands — testWhereNumberRegistration and friends', async () => {
    boot()

    Route.get('/n/{id}', () => 'n').whereNumber('id')
    Route.get('/a/{word}', () => 'a').whereAlpha('word')
    Route.get('/an/{code}', () => 'an').whereAlphaNumeric('code')
    Route.get('/in/{kind}', () => 'in').whereIn('kind', ['news', 'sport'])
    Route.get('/u/{id}', () => 'u').whereUuid('id')

    const routes = compileRoutes('shorthands')

    expect<number>((await call(routes, '/n/12')).status).toBe(200)
    expect<number>((await call(routes, '/n/x')).status).toBe(404)
    expect<number>((await call(routes, '/a/abc')).status).toBe(200)
    expect<number>((await call(routes, '/a/a1')).status).toBe(404)
    expect<number>((await call(routes, '/an/a1')).status).toBe(200)
    expect<number>((await call(routes, '/an/a-1')).status).toBe(404)
    expect<number>((await call(routes, '/in/news')).status).toBe(200)
    expect<number>((await call(routes, '/in/weather')).status).toBe(404)
    expect<number>((await call(routes, '/u/0b3e0f4a-1f2b-4c8d-9a6b-2f1e3d4c5b6a')).status).toBe(200)
    expect<number>((await call(routes, '/u/not-a-uuid')).status).toBe(404)
  })

  test('a global pattern applies everywhere, and a route can override it', async () => {
    boot()

    Route.pattern('id', '[0-9]+')

    Route.get('/first/{id}', () => 'first')
    Route.get('/second/{id}', () => 'second').where('id', '[a-z]+')

    const routes = compileRoutes('patterns')

    expect<number>((await call(routes, '/first/12')).status).toBe(200)
    expect<number>((await call(routes, '/first/ab')).status).toBe(404)
    expect<number>((await call(routes, '/second/ab')).status).toBe(200)
    expect<number>((await call(routes, '/second/12')).status).toBe(404)
  })
})

describe('groups — testCanRegisterGroupWithPrefix and testNestedRouteGroupingPrefixing', () => {
  test('a prefix reaches every route inside', async () => {
    boot()

    Route.prefix('admin').group(() => {
      Route.get('/users', () => 'admin users')
    })

    const routes = compileRoutes('prefix')

    expect<string>(await (await call(routes, '/admin/users')).text()).toBe('admin users')
    expect<number>((await call(routes, '/users')).status).toBe(404)
  })

  test('and nests', async () => {
    boot()

    Route.prefix('admin').group(() => {
      Route.prefix('reports').group(() => {
        Route.get('/daily', () => 'daily')
      })
    })

    const routes = compileRoutes('nested')

    expect<string>(await (await call(routes, '/admin/reports/daily')).text()).toBe('daily')
  })

  test('a name prefix is joined to the route name — testCanRegisterGroupWithNamePrefix', () => {
    const app = boot()

    Route.name('admin.').group(() => {
      Route.get('/admin/users', () => 'x').name('users')
    })

    compileRoutes('names')

    expect<string | undefined>(app.make('routes').path('admin.users')).toBe('/admin/users')
  })

  test('a group controller supplies the class, the route names the method', async () => {
    boot()

    class OrderController {
      show() {
        return 'one order'
      }

      store() {
        return 'stored'
      }
    }

    Route.controller(OrderController).group(() => {
      Route.get('/orders/{id}', 'show')
      Route.post('/orders', 'store')
    })

    const routes = compileRoutes('controller')

    expect<string>(await (await call(routes, '/orders/1')).text()).toBe('one order')
    expect<string>(await (await call(routes, '/orders', { method: 'POST' })).text()).toBe('stored')
  })

  test('attributes chain in any order — testRouteGroupChaining', async () => {
    const app = boot()

    Route.prefix('v1')
      .name('api.')
      .group(() => {
        Route.get('/ping', () => 'pong').name('ping')
      })

    const routes = compileRoutes('chained')

    expect<string>(await (await call(routes, '/v1/ping')).text()).toBe('pong')
    expect<string | undefined>(app.make('routes').path('api.ping')).toBe('/v1/ping')
  })
})

describe('view and redirect — Route::view, Route::redirect', () => {
  test('a redirect answers 302 with the location, and permanent answers 301', async () => {
    boot()

    Route.redirect('/here', '/there')
    Route.permanentRedirect('/old', '/new')

    const routes = compileRoutes('redirects')

    const moved = await call(routes, '/here')

    expect<number>(moved.status).toBe(302)
    expect<string | null>(moved.headers.get('location')).toBe('/there')

    const permanent = await call(routes, '/old')

    expect<number>(permanent.status).toBe(301)
    expect<string | null>(permanent.headers.get('location')).toBe('/new')
  })

  test('a view route renders through the container', async () => {
    const app = boot()

    app.instance(
      'view' as never,
      {
        render: (component: (props: { title: string }) => string, props: { title: string }) =>
          component(props)
      } as never
    )

    Route.view('/', ({ title }: { title: string }) => `<h1>${title}</h1>`, { title: 'Home' })

    const routes = compileRoutes('views')
    const response = await call(routes, '/')

    expect<string>(await response.text()).toBe('<h1>Home</h1>')
    expect<string | null>(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  /**
   * Laravel's fourth and fifth arguments, and the fifth is the one with a job.
   *
   * A view returns markup, not a response, so a route that renders is the only
   * place a header can be named — and a client-routed shell has one it must name.
   * It is the same bytes for everybody, and a response that is cacheable but never
   * says so is one a browser guesses at. Measured after `@elvel/spa` was deleted:
   * the shell went out with no `cache-control` at all, because the handler that
   * used to set it went with the package.
   */
  test('and takes a status and headers, as Laravel does', async () => {
    const app = boot()

    app.instance('view' as never, { render: () => '<p>gone</p>' } as never)

    Route.view('/{path}', () => '<p>gone</p>', {}, 410, {
      'cache-control': 'public, max-age=0, must-revalidate'
    }).where('path', '.*')

    const routes = compileRoutes('views')
    const response = await call(routes, '/anything/at/all')

    expect<number>(response.status).toBe(410)
    expect<string | null>(response.headers.get('cache-control')).toBe(
      'public, max-age=0, must-revalidate'
    )
    // Still a document: the caller's headers are merged over a default, not for it.
    expect<string | null>(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  test('and a caller may override the content type it defaults to', async () => {
    const app = boot()

    app.instance('view' as never, { render: () => '<urlset />' } as never)

    Route.view('/sitemap.xml', () => '<urlset />', {}, 200, {
      'content-type': 'application/xml; charset=utf-8'
    })

    const routes = compileRoutes('views')
    const response = await call(routes, '/sitemap.xml')

    expect<string | null>(response.headers.get('content-type')).toBe(
      'application/xml; charset=utf-8'
    )
  })
})

/**
 * `testFallbackRoute`, and the reason it is not a `/*` route written by hand.
 *
 * Laravel's fallback answers any verb. A hand-written `Route.get('/{path}')`
 * answers a form submission to a missing address with the framework's 404 page,
 * which is the wrong answer and a confusing one.
 */
describe('the fallback', () => {
  test('answers what nothing else claimed, on every verb', async () => {
    boot()

    Route.get('/known', () => 'known')
    Route.fallback(() => 'fell back')

    const routes = compileRoutes('fallback')

    expect<string>(await (await call(routes, '/known')).text()).toBe('known')
    expect<string>(await (await call(routes, '/unknown')).text()).toBe('fell back')
    expect<string>(await (await call(routes, '/deep/link')).text()).toBe('fell back')
    expect<string>(await (await call(routes, '/unknown', { method: 'POST' })).text()).toBe(
      'fell back'
    )
  })

  test('and a real route still wins whatever order they were declared in', async () => {
    boot()

    Route.fallback(() => 'fell back')
    Route.get('/known', () => 'known')

    const routes = compileRoutes('order')

    expect<string>(await (await call(routes, '/known')).text()).toBe('known')
    expect<string>(await (await call(routes, '/other')).text()).toBe('fell back')
  })
})

describe('a wildcard parameter — Route::view("{path}")->where("path", ".*")', () => {
  test('answers every depth, and the prefix itself', async () => {
    boot()

    Route.get('/app/{path}', () => 'client').where('path', '.*')
    Route.get('/app/real', () => 'real route')

    const routes = compileRoutes('wildcard')

    expect<string>(await (await call(routes, '/app')).text()).toBe('client')
    expect<string>(await (await call(routes, '/app/anything')).text()).toBe('client')
    expect<string>(await (await call(routes, '/app/deep/link')).text()).toBe('client')
    expect<string>(await (await call(routes, '/app/real')).text()).toBe('real route')
  })
})

describe('domain — testCanRegisterGroupWithDomain', () => {
  test('a route answers only its host, and the host parameter arrives', async () => {
    boot()

    Route.domain('{account}.example.com').group(() => {
      Route.get(
        '/dashboard',
        ({ params }: { params: Record<string, string> }) => `account ${params.account}`
      )
    })

    const routes = compileRoutes('domain')

    const matched = await routes.handle(
      new Request('http://acme.example.com/dashboard', { headers: { host: 'acme.example.com' } })
    )

    expect<string>(await matched.text()).toBe('account acme')

    const other = await routes.handle(
      new Request('http://elsewhere.test/dashboard', { headers: { host: 'elsewhere.test' } })
    )

    expect<number>(other.status).toBe(404)
  })

  /**
   * Every metacharacter is escaped, not only the dot.
   *
   * The old shape escaped `.` and let the rest through into `new RegExp`, so a
   * domain carrying a bracket either threw at registration or matched something
   * nobody wrote. CodeQL called it incomplete sanitisation; it is reachable only
   * from an application's own source, and it was still a bug.
   */
  test('a host with regex metacharacters in it is matched literally', async () => {
    boot()

    Route.domain('a.b(c).example.com').group(() => {
      Route.get('/x', () => 'matched')
    })

    const routes = compileRoutes('domain')

    const literal = await routes.handle(
      new Request('http://a.b(c).example.com/x', {
        headers: { host: 'a.b(c).example.com' }
      })
    )

    expect<string>(await literal.text()).toBe('matched')

    // `(c)` is a literal here, not a group that could match a bare `c`.
    const asGroup = await routes.handle(
      new Request('http://a.bc.example.com/x', { headers: { host: 'a.bc.example.com' } })
    )

    expect<number>(asGroup.status).toBe(404)
  })
})

/**
 * `Route::current()`, `currentRouteName()`, `currentRouteNamed()`.
 *
 * What this is really for is a navigation component deciding which link is
 * active, three components below the handler, without the name being threaded
 * through props.
 */
describe('the current route — Route::currentRouteName', () => {
  test('its name and URI are readable from inside the handler', async () => {
    boot()

    let seenName: string | undefined
    let seenUri: string | undefined
    let matched = false

    Route.get('/photos/{photo}', () => {
      seenName = currentRouteName()
      seenUri = currentRouteUri()
      matched = currentRouteNamed('photos.*')

      return 'ok'
    }).name('photos.show')

    const routes = compileRoutes('current')

    await call(routes, '/photos/7')

    expect<string | undefined>(seenName).toBe('photos.show')
    expect<string | undefined>(seenUri).toBe('/photos/{photo}')
    expect<boolean>(matched).toBe(true)
  })

  test('a pattern that does not match answers false, and an unnamed route has no name', async () => {
    boot()

    let named: string | undefined = 'unset'
    let matched = true

    Route.get('/anonymous', () => {
      named = currentRouteName()
      matched = currentRouteNamed('photos.*')

      return 'ok'
    })

    const routes = compileRoutes('anonymous')

    await call(routes, '/anonymous')

    expect<string | undefined>(named).toBeUndefined()
    expect<boolean>(matched).toBe(false)
  })
})

/**
 * Elysia's per-route validation, kept reachable from the facade.
 *
 * Laravel has no `->validate()` on a route and needs none; this exists because
 * Elysia's schemas type the handler's `body`, so a mistyped field name is a
 * compile error rather than an `undefined` two layers later.
 */
describe('validation', () => {
  test('a body that does not match never reaches the handler', async () => {
    boot()

    let reached = false

    Route.post('/register', () => {
      reached = true

      return 'registered'
    }).validate({ body: t.Object({ email: t.String() }) })

    const routes = compileRoutes('validate')

    const good = await call(routes, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.test' })
    })

    expect<number>(good.status).toBe(200)
    expect<boolean>(reached).toBe(true)

    reached = false

    const bad = await call(routes, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 })
    })

    expect<boolean>(bad.status >= 400).toBe(true)
    expect<boolean>(reached).toBe(false)
  })

  test('and it composes with middleware on the same route', async () => {
    boot()

    const order: string[] = []

    Route.post('/guarded', () => {
      order.push('handler')

      return 'ok'
    }).validate({ body: t.Object({ email: t.String() }) })

    const routes = compileRoutes('validate-and-guard')

    await call(routes, '/guarded', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.test' })
    })

    expect<string[]>(order).toEqual(['handler'])
  })
})
