import { describe, expect, test } from 'bun:test'
import { compileUri, isWildcard, parseUri, rootFor } from '../src/router/uri.ts'

/**
 * The parsing cases are `Illuminate\Tests\Routing\RouteUriTest::uriProvider`,
 * one for one, so a URI written from a Laravel example parses the same way here.
 *
 * `{bar:slug}` is in that provider and is the reason this file reproduces it
 * rather than inventing its own cases: nothing in Laravel's *documentation* says
 * a parameter can name its binding field in the path, and a router that dropped
 * it would fail on a route somebody copied out of a real application.
 */
describe('parsing a URI the way Laravel writes it', () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ['/foo', '/foo', {}],
    ['/foo/{bar}', '/foo/{bar}', {}],
    ['/foo/{bar}/baz/{qux}', '/foo/{bar}/baz/{qux}', {}],
    ['/foo/{bar}/baz/{qux?}', '/foo/{bar}/baz/{qux?}', {}],
    ['/foo/{bar:slug}', '/foo/{bar}', { bar: 'slug' }],
    ['/foo/{bar}/baz/{qux:slug}', '/foo/{bar}/baz/{qux}', { qux: 'slug' }],
    ['/foo/{bar}/baz/{qux:slug?}', '/foo/{bar}/baz/{qux?}', { qux: 'slug' }],
    [
      '/foo/{bar}/baz/{qux:slug?}/{test:id?}',
      '/foo/{bar}/baz/{qux?}/{test?}',
      { qux: 'slug', test: 'id' }
    ]
  ]

  for (const [uri, expected, bindingFields] of cases) {
    test(`${uri} → ${expected}`, () => {
      const parsed = parseUri(uri)

      expect<string>(parsed.uri).toBe(expected)
      expect<Record<string, string>>(parsed.bindingFields).toEqual(bindingFields)
    })
  }

  test('parameters and the optional ones are reported in order', () => {
    const parsed = parseUri('/foo/{bar}/baz/{qux:slug?}/{test?}')

    expect<string[]>(parsed.parameters).toEqual(['bar', 'qux', 'test'])
    expect<string[]>(parsed.optional).toEqual(['qux', 'test'])
  })

  /**
   * `Route::get('users')` and `Route::get('/users')` are one route in Laravel.
   *
   * Worth a test rather than an assumption: half the examples in Laravel's own
   * documentation are written without the slash, and a framework that made those
   * a different route would break on a copied example.
   */
  test('a missing leading slash is added', () => {
    expect<string>(parseUri('users').uri).toBe('/users')
    expect<string>(parseUri('users/{id}').uri).toBe('/users/{id}')
  })
})

describe('compiling a URI for Elysia', () => {
  test('a parameter becomes a colon, an optional one keeps its question mark', () => {
    expect<string>(compileUri(parseUri('/users/{id}'))).toBe('/users/:id')
    expect<string>(compileUri(parseUri('/users/{id?}'))).toBe('/users/:id?')
    expect<string>(compileUri(parseUri('/a/{b}/c/{d?}'))).toBe('/a/:b/c/:d?')
  })

  test('a binding field is not part of the path Elysia matches', () => {
    expect<string>(compileUri(parseUri('/posts/{post:slug}'))).toBe('/posts/:post')
  })

  /**
   * The one constraint that changes matching rather than filtering.
   *
   * `Route::view('/{path}', 'main')->where('path', '.*')` is how a Laravel
   * application hands every address to a client-side router, and it is the shape
   * this whole layer has to get right.
   */
  describe('a parameter constrained to .* is a wildcard', () => {
    /**
     * Measured, one route at a time: Elysia answers `/` from `/*` with 200, so
     * the root wildcard needs no second registration. A prefixed one does —
     * `/admin/*` answered `/admin` with 404 — which is the case below.
     */
    test('at the root, and it already covers the root itself', () => {
      const parsed = parseUri('/{path}')

      expect<string>(compileUri(parsed, { path: '.*' })).toBe('/*')
      expect<string | undefined>(rootFor(parsed, { path: '.*' })).toBeUndefined()
      expect<boolean>(isWildcard(parsed, { path: '.*' })).toBe(true)
    })

    test('under a prefix', () => {
      const parsed = parseUri('/admin/{rest}')

      expect<string>(compileUri(parsed, { rest: '.*' })).toBe('/admin/*')
      expect<string | undefined>(rootFor(parsed, { rest: '.*' })).toBe('/admin')
    })

    test('and an optional one is the same wildcard', () => {
      const parsed = parseUri('/{path?}')

      expect<string>(compileUri(parsed, { path: '.*' })).toBe('/*')
      expect<string | undefined>(rootFor(parsed, { path: '.*' })).toBeUndefined()
    })

    test('while any other constraint leaves the path alone', () => {
      const parsed = parseUri('/users/{id}')

      expect<string>(compileUri(parsed, { id: '[0-9]+' })).toBe('/users/:id')
      expect<string | undefined>(rootFor(parsed, { id: '[0-9]+' })).toBeUndefined()
      expect<boolean>(isWildcard(parsed, { id: '[0-9]+' })).toBe(false)
    })
  })
})

describe('the parameter pattern', () => {
  /**
   * Linear on input that used to be quadratic.
   *
   * `{{0` followed by a long run of spaces made the old pattern try every way of
   * splitting those spaces between two adjacent `\s*` runs. Only an application's
   * own source reaches this, so nobody could have attacked it — but the pattern was
   * ambiguous with itself, and that is worth being rid of.
   */
  test('does not backtrack on a long run of spaces', () => {
    const hostile = `{{0${' '.repeat(50000)}`

    const started = performance.now()
    parseUri(hostile)
    const elapsed = performance.now() - started

    // Generous on purpose. Measured on the two patterns directly, the old one is
    // quadratic — 2ms at 2,000 spaces, 5ms at 4,000, 18ms at 8,000, so roughly
    // 700ms at the 50,000 here — while the new one stays under a tenth of a
    // millisecond throughout. The threshold sits between the two.
    expect<boolean>(elapsed < 500).toBe(true)
  })

  /**
   * Whitespace inside the braces is not a parameter, which is Laravel's rule:
   * `RouteUri.php` matches `/\{([\w\:]+?)\??\}/` and nothing looser.
   */
  test('and a spaced brace is left alone rather than parsed', () => {
    expect<string[]>(parseUri('/users/{ id }').parameters).toEqual([])
    expect<string[]>(parseUri('/users/{id}').parameters).toEqual(['id'])
  })
})
