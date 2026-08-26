import { afterEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { compileRoutes } from '../src/router/compile.ts'
import { current } from '../src/router/current.ts'
import { drainRoutes, Route, resetRouter } from '../src/router/registrar.ts'
import { RouteRegistry } from '../src/routes.ts'

/**
 * `Route::metadata`, from Laravel 13.
 *
 * Six tests in `Illuminate\Tests\Routing\RouteRegistrarTest` decide what this
 * means, and each one below names the test it came from. They are worth copying
 * rather than paraphrasing because two of the rules are not what a reader would
 * guess from the merge function: a list replaces a list, and an **empty** object
 * clears the group's value instead of inheriting it.
 *
 * The second one is a PHP artefact reproduced deliberately. `mergableMetadata`
 * asks `Arr::isAssoc()`, and an empty PHP array is not associative — so
 * `metadata(['head' => []])` replaces. `{}` in JavaScript is unambiguously an
 * object, so the condition had to be written as "an object with something in it"
 * to land on the same behaviour.
 */
afterEach(() => {
  resetRouter()
})

function boot(): Application {
  const app = new Application(process.cwd())

  app.config.set('app.env', 'testing')
  app.instance('routes', new RouteRegistry())

  return app
}

/** The one route this file declares, read back before it is compiled away. */
function declared() {
  const routes = drainRoutes()

  expect<number>(routes.length).toBe(1)

  return routes[0] as NonNullable<(typeof routes)[0]>
}

describe('testCanSetRouteMetadata', () => {
  test("a route's metadata merges over its group's, and reads by dotted path", () => {
    boot()

    Route.metadata({ head: { title: 'Users' } })
      .get('/users', () => 'all-users')
      .metadata({ head: { description: 'All users.' } })

    const route = declared()

    expect<unknown>(route.getMetadata('head')).toEqual({
      title: 'Users',
      description: 'All users.'
    })
    expect<unknown>(route.getMetadata('head.title')).toBe('Users')
  })

  test('and answers everything when asked for no key', () => {
    boot()

    Route.get('/users', () => 'all-users').metadata({ head: { title: 'Users' } })

    expect<unknown>(declared().getMetadata()).toEqual({ head: { title: 'Users' } })
  })

  test('a key that was never set answers the fallback', () => {
    boot()

    Route.get('/users', () => 'all-users').metadata({ head: { title: 'Users' } })

    const route = declared()

    expect<unknown>(route.getMetadata('head.robots')).toBeUndefined()
    expect<unknown>(route.getMetadata('head.robots', ['index'])).toEqual(['index'])
    expect<unknown>(route.getMetadata('nothing.here', 'fallback')).toBe('fallback')
  })
})

describe('testCanSetRouteMetadataOnGroup', () => {
  test('the group is merged into, not replaced', () => {
    boot()

    Route.metadata({ head: { robots: ['noindex', 'nofollow'] } }).group(() => {
      Route.get('/users', () => 'all-users').metadata({ head: { title: 'Users' } })
    })

    expect<unknown>(declared().getMetadata('head')).toEqual({
      robots: ['noindex', 'nofollow'],
      title: 'Users'
    })
  })

  test('and a nested group deepens the one above it', () => {
    boot()

    Route.metadata({ head: { robots: ['noindex'] } }).group(() => {
      Route.metadata({ head: { title: 'Admin' } }).group(() => {
        Route.get('/users', () => 'all-users').metadata({ head: { description: 'Users.' } })
      })
    })

    expect<unknown>(declared().getMetadata('head')).toEqual({
      robots: ['noindex'],
      title: 'Admin',
      description: 'Users.'
    })
  })
})

describe('testRouteMetadataListValuesReplaceParentValues', () => {
  test('a list replaces a list rather than concatenating', () => {
    boot()

    Route.metadata({ head: { robots: ['index', 'follow'] } }).group(() => {
      Route.metadata({ head: { robots: ['noindex'] } }).group(() => {
        Route.get('/users', () => 'all-users')
      })
    })

    expect<unknown>(declared().getMetadata('head.robots')).toEqual(['noindex'])
  })
})

describe('testCanSetRouteMetadataOnGroupUsingArraySyntax', () => {
  test('the object form of a group carries it too', () => {
    boot()

    Route.group({ metadata: { head: { title: 'Users' } } }, () => {
      Route.get('/users', () => 'all-users')
    })

    expect<unknown>(declared().getMetadata('head')).toEqual({ title: 'Users' })
  })
})

describe('testEmptyRouteMetadataArrayReplacesParentValue', () => {
  /**
   * An empty object clears, which is the only way to unset a group's value.
   *
   * Merging it would make a group's `head` impossible to escape — and the route
   * that wants no title at all is exactly the one that cannot say so any other
   * way.
   */
  test('an empty object replaces the parent value', () => {
    boot()

    Route.metadata({ head: { title: 'Users' } }).group(() => {
      Route.get('/users', () => 'all-users').metadata({ head: {} })
    })

    expect<unknown>(declared().getMetadata('head')).toEqual({})
  })
})

describe('testRouteMetadataAttributeRequiresArray', () => {
  test('a value that is not an object is refused', () => {
    boot()

    const route = Route.get('/users', () => 'all-users')

    expect(() => route.metadata('invalid' as never)).toThrow('metadata() expects an object.')
    expect(() => route.metadata(['invalid'] as never)).toThrow('metadata() expects an object.')
  })
})

describe('what it is for', () => {
  /**
   * Reachable from inside the handler, which is the whole point.
   *
   * A layout asking for `head.title` three components down cannot be handed it
   * through props without every component in between carrying it, and that is the
   * plumbing that makes people hard-code the title instead.
   */
  test('the current route carries it into the handler', async () => {
    boot()

    let seen: unknown

    Route.metadata({ head: { robots: ['noindex'] } }).group(() => {
      Route.get('/users', () => {
        seen = current()?.getMetadata('head')

        return 'ok'
      }).metadata({ head: { title: 'Users' } })
    })

    const routes = compileRoutes('metadata')

    await routes.handle(new Request('http://localhost/users'))

    expect<unknown>(seen).toEqual({ robots: ['noindex'], title: 'Users' })
  })
})
