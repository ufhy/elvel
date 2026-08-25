import { afterEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { bindings } from '../src/bindings.ts'
import { HttpServiceProvider } from '../src/provider.ts'
import { compileRoutes } from '../src/router/compile.ts'
import { Route, resetRouter } from '../src/router/registrar.ts'

/**
 * Route model binding through the facade: `{post:slug}`, `scopeBindings()`, and
 * `missing()`.
 *
 * All three were accepted and silently did nothing before these tests existed.
 * `missing()` was the worst of them — measured, a route with an unresolvable
 * binding answered 404 and the handler that was supposed to redirect never ran.
 */
afterEach(() => {
  resetRouter()
})

async function boot(): Promise<Application> {
  return Application.configure(process.cwd()).withProviders([HttpServiceProvider]).create()
}

describe('missing()', () => {
  test('answers for a binding that resolved to nothing', async () => {
    const app = await boot()

    bindings().bind('post', () => undefined)

    let handlerRan = false

    Route.get('/posts/{post}', () => {
      handlerRan = true

      return 'found'
    })
      .middleware('bindings')
      .missing(() => new Response(null, { status: 302, headers: { location: '/posts' } }))

    app.useRoutes(compileRoutes('missing'))

    const response = await app.handle(new Request('http://localhost/posts/9'))

    expect<number>(response.status).toBe(302)
    expect<string | null>(response.headers.get('location')).toBe('/posts')
    expect<boolean>(handlerRan).toBe(false)
  })

  test('and stays out of the way when the binding resolves', async () => {
    const app = await boot()

    bindings().bind('post', (value) => ({ id: value }))

    Route.get('/posts/{post}', () => 'found')
      .middleware('bindings')
      .missing(() => new Response('should not happen', { status: 302 }))

    app.useRoutes(compileRoutes('present'))

    const response = await app.handle(new Request('http://localhost/posts/9'))

    expect<number>(response.status).toBe(200)
    expect<string>(await response.text()).toBe('found')
  })

  /**
   * A failure that is not a missing model must not be dressed up as one.
   *
   * `missing()` catching everything would turn a broken query into a redirect,
   * and the bug would then be invisible for as long as somebody kept clicking.
   */
  test('does not swallow a real failure', async () => {
    const app = await boot()

    bindings().bind('post', () => {
      throw new Error('the database is on fire')
    })

    Route.get('/posts/{post}', () => 'found')
      .middleware('bindings')
      .missing(() => new Response(null, { status: 302 }))

    app.useRoutes(compileRoutes('failure'))

    const response = await app.handle(new Request('http://localhost/posts/9'))

    expect<boolean>(response.status >= 500).toBe(true)
  })
})

describe('{post:slug} — a binding field named in the path', () => {
  test('reaches the resolver as the field', async () => {
    const app = await boot()

    let seenField: string | undefined

    bindings().model('post', {
      routeKeyName: () => 'id',
      resolveRouteBinding: async (value: string, field?: string) => {
        seenField = field

        return { value, field }
      }
    })

    Route.get('/posts/{post:slug}', () => 'ok').middleware('bindings')

    app.useRoutes(compileRoutes('field'))

    await app.handle(new Request('http://localhost/posts/hello-world'))

    expect<string | undefined>(seenField).toBe('slug')
  })

  test('and is absent when the path did not name one', async () => {
    const app = await boot()

    let seenField: string | undefined = 'unset'

    bindings().model('post', {
      routeKeyName: () => 'id',
      resolveRouteBinding: async (value: string, field?: string) => {
        seenField = field

        return { value }
      }
    })

    Route.get('/posts/{post}', () => 'ok').middleware('bindings')

    app.useRoutes(compileRoutes('no-field'))

    await app.handle(new Request('http://localhost/posts/9'))

    expect<string | undefined>(seenField).toBeUndefined()
  })
})

describe('scopeBindings()', () => {
  /**
   * The parent and the relation are read off the URI, as Laravel reads them.
   *
   * `/photos/{photo}/comments/{comment}` says the parent is `photo` and the
   * relation is `comments` — the segment in front of the child. That is why
   * `scopeBindings()` takes no arguments.
   */
  test('resolves the child through its parent', async () => {
    const app = await boot()

    const calls: Array<{ relation: string; value: string; parent: unknown }> = []

    bindings().bind('photo', (value) => ({ id: value }))
    bindings().model('comment', {
      routeKeyName: () => 'id',
      resolveRouteBinding: async () => {
        throw new Error('resolved on its own, which a scoped child must never be')
      },
      resolveChildRouteBinding: async (parent: unknown, relation: string, value: string) => {
        calls.push({ relation, value, parent })

        return { id: value }
      }
    })

    Route.get('/photos/{photo}/comments/{comment}', () => 'ok')
      .middleware('bindings')
      .scopeBindings()

    app.useRoutes(compileRoutes('scoped'))

    const response = await app.handle(new Request('http://localhost/photos/3/comments/7'))

    expect<number>(response.status).toBe(200)
    expect<number>(calls.length).toBe(1)
    expect<string>(calls[0]?.relation as string).toBe('comments')
    expect<string>(calls[0]?.value as string).toBe('7')
    expect<unknown>(calls[0]?.parent).toEqual({ id: '3' })
  })

  test('and without it the child resolves on its own', async () => {
    const app = await boot()

    let scopedCalls = 0
    let plainCalls = 0

    bindings().bind('photo', (value) => ({ id: value }))
    bindings().model('comment', {
      routeKeyName: () => 'id',
      resolveRouteBinding: async (value: string) => {
        plainCalls += 1

        return { id: value }
      },
      resolveChildRouteBinding: async () => {
        scopedCalls += 1

        return {}
      }
    })

    Route.get('/photos/{photo}/comments/{comment}', () => 'ok').middleware('bindings')

    app.useRoutes(compileRoutes('unscoped'))

    await app.handle(new Request('http://localhost/photos/3/comments/7'))

    expect<number>(plainCalls).toBe(1)
    expect<number>(scopedCalls).toBe(0)
  })
})
