import { describe, expect, test } from 'bun:test'
import {
  actualHeaders,
  corsConfig,
  corsFor,
  corsResolver,
  isCorsRequest,
  isOriginAllowed,
  isPreflight,
  pathMatcher,
  pathMatches,
  preflightHeaders
} from '../src/cors.ts'

const request = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`http://localhost${path}`, { method, headers })

describe('what counts as CORS', () => {
  test('an Origin header is what makes a request cross-origin', () => {
    expect(isCorsRequest(request('/api/x'))).toBe(false)
    expect(isCorsRequest(request('/api/x', { origin: 'https://app.test' }))).toBe(true)
  })

  test('a preflight is OPTIONS *plus* the method header', () => {
    expect(isPreflight(request('/api/x', {}, 'OPTIONS'))).toBe(false)
    expect(
      isPreflight(request('/api/x', { 'access-control-request-method': 'POST' }, 'OPTIONS'))
    ).toBe(true)
    // A GET with the header is not a preflight either.
    expect(isPreflight(request('/api/x', { 'access-control-request-method': 'POST' }))).toBe(false)
  })
})

describe('paths', () => {
  const config = corsConfig({ paths: ['api/*', 'health'] })

  test('a wildcard matches below the prefix', () => {
    expect(pathMatches(config, request('/api/orders'))).toBe(true)
    expect(pathMatches(config, request('/api/orders/1/lines'))).toBe(true)
  })

  test('an exact path matches only itself', () => {
    expect(pathMatches(config, request('/health'))).toBe(true)
    expect(pathMatches(config, request('/health/deep'))).toBe(false)
  })

  test('anything else is not CORS at all', () => {
    expect(pathMatches(config, request('/login'))).toBe(false)
  })

  test('a bare * matches everything', () => {
    expect(pathMatches(corsConfig({ paths: ['*'] }), request('/anything'))).toBe(true)
  })
})

describe('origins', () => {
  test('* allows anyone', () => {
    expect(isOriginAllowed(corsConfig(), 'https://anything.test')).toBe(true)
  })

  test('a named list allows only its members', () => {
    const config = corsConfig({ allowedOrigins: ['https://app.test'] })

    expect(isOriginAllowed(config, 'https://app.test')).toBe(true)
    expect(isOriginAllowed(config, 'https://evil.test')).toBe(false)
  })

  test('a pattern covers a family of subdomains', () => {
    const config = corsConfig({
      allowedOrigins: [],
      allowedOriginsPatterns: ['^https://[a-z0-9-]+\\.app\\.test$']
    })

    expect(isOriginAllowed(config, 'https://tenant-7.app.test')).toBe(true)
    expect(isOriginAllowed(config, 'https://app.test')).toBe(false)
  })
})

describe('actual request headers', () => {
  test('* with no credentials is the cacheable answer', () => {
    const headers = actualHeaders(
      corsConfig({ paths: ['*'] }),
      request('/x', { origin: 'https://a.test' })
    )

    expect(headers['Access-Control-Allow-Origin']).toBe('*')
    // One answer for everybody, so nothing to vary on.
    expect(headers.Vary).toBeUndefined()
  })

  test('* with credentials echoes the origin instead, never *', () => {
    // A browser refuses `*` on a credentialed request, so allowing "any origin"
    // has to mean echoing the caller's — after checking it.
    const headers = actualHeaders(
      corsConfig({ supportsCredentials: true }),
      request('/x', { origin: 'https://a.test' })
    )

    expect(headers['Access-Control-Allow-Origin']).toBe('https://a.test')
    expect(headers['Access-Control-Allow-Credentials']).toBe('true')
    // Without this a shared cache can hand one site's response to another.
    expect(headers.Vary).toBe('Origin')
  })

  test('a single named origin is sent as itself', () => {
    const config = corsConfig({ allowedOrigins: ['https://app.test'] })

    expect(actualHeaders(config, request('/x', { origin: 'https://app.test' }))).toEqual({
      'Access-Control-Allow-Origin': 'https://app.test'
    })
  })

  test('a refused origin gets no allow header, only Vary', () => {
    const config = corsConfig({ allowedOrigins: ['https://app.test'] })
    const headers = actualHeaders(config, request('/x', { origin: 'https://evil.test' }))

    // Refusing is the *absence* of the header: the browser turns that into an
    // error, and answering 403 would break same-origin callers of the same route.
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(headers.Vary).toBe('Origin')
  })

  test('a request with no Origin gets nothing', () => {
    expect(actualHeaders(corsConfig(), request('/x'))).toEqual({})
  })

  test('exposed headers are listed for the browser to read', () => {
    const config = corsConfig({ exposedHeaders: ['X-RateLimit-Remaining'] })
    const headers = actualHeaders(config, request('/x', { origin: 'https://a.test' }))

    expect(headers['Access-Control-Expose-Headers']).toBe('X-RateLimit-Remaining')
  })
})

describe('preflight headers', () => {
  const preflight = (headers: Record<string, string>, config = corsConfig()) =>
    preflightHeaders(config, request('/x', headers, 'OPTIONS'))

  test('* methods echoes the requested one', () => {
    const headers = preflight({
      origin: 'https://a.test',
      'access-control-request-method': 'delete'
    })

    expect(headers['Access-Control-Allow-Methods']).toBe('DELETE')
  })

  test('a named list is sent whole, upper-cased', () => {
    const headers = preflight(
      { origin: 'https://a.test', 'access-control-request-method': 'POST' },
      corsConfig({ allowedMethods: ['get', 'post'] })
    )

    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST')
  })

  test('* headers echoes what was asked for', () => {
    const headers = preflight({
      origin: 'https://a.test',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-csrf-token'
    })

    expect(headers['Access-Control-Allow-Headers']).toBe('content-type,x-csrf-token')
  })

  test('max-age is only sent when set', () => {
    expect(
      preflight({ origin: 'https://a.test', 'access-control-request-method': 'POST' })[
        'Access-Control-Max-Age'
      ]
    ).toBeUndefined()

    expect(
      preflight(
        { origin: 'https://a.test', 'access-control-request-method': 'POST' },
        corsConfig({ maxAge: 600 })
      )['Access-Control-Max-Age']
    ).toBe('600')
  })

  test('the answer varies on the request method header', () => {
    const headers = preflight({
      origin: 'https://a.test',
      'access-control-request-method': 'POST'
    })

    expect(headers.Vary).toContain('Access-Control-Request-Method')
  })

  test('a refused origin is told nothing about what is allowed', () => {
    const headers = preflight(
      { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
      corsConfig({ allowedOrigins: ['https://app.test'] })
    )

    // Not just the origin: a refused caller must not be handed the methods,
    // headers, credentials flag or max-age either.
    expect(headers['Access-Control-Allow-Methods']).toBeUndefined()
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(headers['Access-Control-Allow-Headers']).toBeUndefined()
    expect(headers['Access-Control-Max-Age']).toBeUndefined()
  })

  test('and neither is a refused credentialed caller', () => {
    const headers = actualHeaders(
      corsConfig({
        allowedOrigins: ['https://app.test'],
        supportsCredentials: true,
        exposedHeaders: ['X-Thing']
      }),
      request('/x', { origin: 'https://evil.test' })
    )

    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined()
    expect(headers['Access-Control-Expose-Headers']).toBeUndefined()
  })
})

describe('per-route overrides', () => {
  const global = corsConfig({ paths: ['api/*'], allowedOrigins: ['https://app.example.com'] })

  const overrides = [
    { paths: ['api/public/*'], allowedOrigins: ['*'] },
    { paths: ['api/*'], supportsCredentials: true }
  ]

  const at = (path: string) =>
    new Request(`http://localhost/${path}`, {
      headers: { origin: 'https://somewhere.test' }
    })

  test('a matching override widens only its own paths', () => {
    // One public endpoint inside an API that otherwise answers your own front
    // end — the case a single global config cannot express without widening
    // everything.
    expect<boolean>(
      isOriginAllowed(corsFor(at('api/public/rates'), global, overrides), 'https://somewhere.test')
    ).toBe(true)
    expect<boolean>(
      isOriginAllowed(corsFor(at('api/orders'), global, overrides), 'https://somewhere.test')
    ).toBe(false)
  })

  test('the first match wins, so a specific rule goes above a broad one', () => {
    const config = corsFor(at('api/public/rates'), global, overrides)

    // The broad `api/*` rule would have turned credentials on; the specific rule
    // matched first and did not.
    expect<boolean>(config.supportsCredentials).toBe(false)
    expect<boolean>(corsFor(at('api/orders'), global, overrides).supportsCredentials).toBe(true)
  })

  test('an override keeps every decision it does not mention', () => {
    const config = corsFor(at('api/orders'), global, overrides)

    expect<string[]>(config.allowedOrigins).toEqual(['https://app.example.com'])
  })

  test('no override leaves the global config alone', () => {
    expect<unknown>(corsFor(at('api/orders'), global, [])).toEqual(global)
  })
})

describe('the compiled path matcher', () => {
  /**
   * Both hooks used to resolve the config and match the path again, parsing the
   * URL and rebuilding regexes each time — 2.6µs per request for two configured
   * paths, paid whether the path matched or not.
   */
  test('answers the same paths the old matcher did', () => {
    const matches = pathMatcher(['api/*', '/health', 'check/cors/*'])

    expect<boolean>(matches('api/users')).toBe(true)
    expect<boolean>(matches('health')).toBe(true)
    expect<boolean>(matches('check/cors/anything/deep')).toBe(true)
    expect<boolean>(matches('healthy')).toBe(false)
    expect<boolean>(matches('apix/users')).toBe(false)
    expect<boolean>(matches('')).toBe(false)
  })

  test('and a bare star matches everything', () => {
    const matches = pathMatcher(['*'])

    expect<boolean>(matches('anything')).toBe(true)
    expect<boolean>(matches('')).toBe(true)
  })

  /** A dot in a pattern is a dot, not "any character". */
  test('while a dot stays literal', () => {
    const matches = pathMatcher(['files/*.json'])

    expect<boolean>(matches('files/a.json')).toBe(true)
    expect<boolean>(matches('files/axjson')).toBe(false)
  })

  /** An override wins over the global config, and is merged once. */
  test('and an override takes the path it claims', () => {
    const global = corsConfig({ paths: ['api/*'], allowedOrigins: ['https://a.test'] })
    const resolve = corsResolver(global, [
      { paths: ['api/public/*'], allowedOrigins: ['*'] } as never
    ])

    expect<string[] | undefined>(resolve('api/public/thing')?.allowedOrigins).toEqual(['*'])
    expect<string[] | undefined>(resolve('api/private')?.allowedOrigins).toEqual(['https://a.test'])
    // Nothing configured for this path at all.
    expect<unknown>(resolve('other')).toBeUndefined()
  })
})
