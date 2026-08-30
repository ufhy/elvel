import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { Elysia } from 'elysia'
import { HttpServiceProvider } from '../src/index.ts'
import { cspNonce } from '../src/scope.ts'
import { contentSecurityPolicy, securityHeaders, securityHeaderWriter } from '../src/security.ts'

describe('the headers a framework can get right once', () => {
  test('all of them, from an empty config', () => {
    const headers = securityHeaders({}, { secure: true })

    expect<string | undefined>(headers['x-content-type-options']).toBe('nosniff')
    expect<string | undefined>(headers['x-frame-options']).toBe('DENY')
    expect<string | undefined>(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect<string | undefined>(headers['permissions-policy']).toContain('camera=()')
    expect<string | undefined>(headers['cross-origin-opener-policy']).toBe('same-origin')
    expect<string | undefined>(headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains'
    )
  })

  /**
   * HSTS is the one that cannot be undone by hand.
   *
   * A browser ignores it over plain HTTP, so sending it in development achieves
   * nothing — except on `localhost`, where it is remembered per host and outlives
   * the project that sent it.
   */
  test('HSTS waits for production', () => {
    expect<string | undefined>(
      securityHeaders({}, { secure: false })['strict-transport-security']
    ).toBeUndefined()
  })

  test('any of them can be refused', () => {
    const headers = securityHeaders(
      { frameOptions: false, referrerPolicy: false, hsts: false, csp: false },
      { secure: true }
    )

    expect<string[]>(Object.keys(headers).sort()).toEqual([
      'cross-origin-opener-policy',
      'permissions-policy',
      'x-content-type-options'
    ])
  })

  test('preload is opt-in, because it is close to permanent', () => {
    const headers = securityHeaders(
      { hsts: { maxAge: 100, includeSubDomains: false, preload: true } },
      { secure: true }
    )

    expect<string | undefined>(headers['strict-transport-security']).toBe('max-age=100; preload')
  })
})

describe('the policy', () => {
  test('defaults to itself, and takes a nonce for the script that needs one', () => {
    const policy = contentSecurityPolicy({}, { secure: true, nonce: 'abc123' }) ?? ''

    expect<boolean>(policy.includes("default-src 'self'")).toBe(true)
    expect<boolean>(policy.includes("object-src 'none'")).toBe(true)
    expect<boolean>(policy.includes("frame-ancestors 'none'")).toBe(true)
    expect<boolean>(policy.includes("script-src 'self' 'nonce-abc123'")).toBe(true)

    /**
     * Inline styles are allowed and inline scripts are not, deliberately.
     *
     * A view is allowed to carry its own styles — the scaffold's landing page
     * does, because a stylesheet request before the first paint is a flash of
     * unstyled text. Allowing an inline *script* is allowing the injected one.
     */
    expect<boolean>(policy.includes("style-src 'self' 'unsafe-inline'")).toBe(true)
    expect<boolean>(policy.includes("script-src 'self' 'unsafe-inline'")).toBe(false)
  })

  test('a named directive replaces that one and leaves the rest', () => {
    const policy =
      contentSecurityPolicy(
        { directives: { 'img-src': ["'self'", 'https://cdn.example.com'], 'font-src': false } },
        { secure: true }
      ) ?? ''

    expect<boolean>(policy.includes("img-src 'self' https://cdn.example.com")).toBe(true)
    expect<boolean>(policy.includes('font-src')).toBe(false)
    expect<boolean>(policy.includes("default-src 'self'")).toBe(true)
  })

  /**
   * The dev server is another origin, and its socket another scheme.
   *
   * A policy that is right in production blocks every module in development
   * without this — which is how a policy ends up disabled in development and
   * therefore first tested by the deploy.
   */
  test('the dev server is allowed while one is running', () => {
    const policy =
      contentSecurityPolicy({}, { secure: false, devOrigin: 'http://localhost:5173' }) ?? ''

    expect<boolean>(policy.includes("script-src 'self' http://localhost:5173")).toBe(true)
    expect<boolean>(policy.includes('ws://localhost:5173')).toBe(true)
  })

  test('report-only is a different header, not a different policy', () => {
    const reporting = securityHeaders({ csp: { reportOnly: true } }, { secure: true })

    expect<boolean>('content-security-policy-report-only' in reporting).toBe(true)
    expect<boolean>('content-security-policy' in reporting).toBe(false)
  })
})

/** A real application, because what is being tested is which responses carry them. */
async function application(): Promise<Application> {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', 'testing')
  app.config.set('session', { driver: 'memory' })

  await app.register(HttpServiceProvider)
  await app.boot()

  app.handleExceptions()

  return app
}

describe('which responses carry them', () => {
  test('a handler response does', async () => {
    const app = await application()

    app.useRoutes(new Elysia().get('/page', () => 'ok'))

    const response = await app.handle(new Request('http://localhost/page'))

    expect<string | null>(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect<string | null>(response.headers.get('content-security-policy')).toContain(
      "default-src 'self'"
    )
  })

  /**
   * And so does a response with no handler.
   *
   * `mapResponse` covers the handler path and nothing else — measured, an
   * unmatched path came back with none of these — so the error path is served by
   * `request.lifecycle`, which exists for exactly this shape of gap.
   */
  test('an error response does too', async () => {
    const app = await application()

    const response = await app.handle(new Request('http://localhost/nowhere'))

    expect<number>(response.status).toBe(404)
    expect<string | null>(response.headers.get('x-frame-options')).toBe('DENY')
    expect<string | null>(response.headers.get('content-security-policy')).toContain(
      "object-src 'none'"
    )
  })

  /**
   * The nonce a view renders is the nonce the header names.
   *
   * Two moments in one request — the policy is built when the response is mapped,
   * the nonce is read while the page renders — so a nonce generated by either one
   * of them would be a nonce the other has never seen, and the browser would
   * refuse the script.
   */
  test('the nonce in the page is the nonce in the policy', async () => {
    const app = await application()

    app.useRoutes(new Elysia().get('/inline', () => cspNonce()))

    const response = await app.handle(new Request('http://localhost/inline'))
    const rendered = await response.text()

    expect<number>(rendered.length).toBeGreaterThan(0)
    expect<string | null>(response.headers.get('content-security-policy')).toContain(
      `'nonce-${rendered}'`
    )
  })

  test('a fresh nonce per response', async () => {
    const app = await application()

    app.useRoutes(new Elysia().get('/inline', () => cspNonce()))

    const first = await (await app.handle(new Request('http://localhost/inline'))).text()
    const second = await (await app.handle(new Request('http://localhost/inline'))).text()

    expect<boolean>(first === second).toBe(false)
  })

  test('`enabled: false` sends none of it', async () => {
    const app = new Application(process.cwd())

    app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
    app.config.set('app.env', 'testing')
    app.config.set('session', { driver: 'memory' })
    app.config.set('security', { enabled: false })

    await app.register(HttpServiceProvider)
    await app.boot()
    app.handleExceptions()

    app.useRoutes(new Elysia().get('/page', () => 'ok'))

    const response = await app.handle(new Request('http://localhost/page'))

    expect<string | null>(response.headers.get('x-content-type-options')).toBeNull()
    expect<string | null>(response.headers.get('content-security-policy')).toBeNull()
  })
})

describe('headers prepared at boot', () => {
  /**
   * Everything but the nonce is fixed, so it is built once. Rebuilding the map per
   * response cost 3.2µs of the security plugin's 5.0µs — measured by swapping the
   * live build for a constant and remeasuring the server.
   */
  test('splices the nonce into a policy built once', () => {
    const write = securityHeaderWriter({}, true)
    const first: Record<string, string> = {}
    const second: Record<string, string> = {}

    write('AAA', undefined, (name, value) => {
      first[name] = value
    })
    write('BBB', undefined, (name, value) => {
      second[name] = value
    })

    expect<boolean>((first['content-security-policy'] ?? '').includes("'nonce-AAA'")).toBe(true)
    expect<boolean>((second['content-security-policy'] ?? '').includes("'nonce-BBB'")).toBe(true)
    // Everything around it is the same string, which is the point of precomputing.
    expect<string>((first['content-security-policy'] ?? '').replace("'nonce-AAA'", 'X')).toBe(
      (second['content-security-policy'] ?? '').replace("'nonce-BBB'", 'X')
    )
  })

  /** No nonce means no nonce token, not an empty one. */
  test('and leaves it out when there is none', () => {
    const write = securityHeaderWriter({}, true)
    const headers: Record<string, string> = {}

    write(undefined, undefined, (name, value) => {
      headers[name] = value
    })

    expect<boolean>((headers['content-security-policy'] ?? '').includes('nonce-')).toBe(false)
    expect<boolean>((headers['content-security-policy'] ?? '').includes("script-src 'self'")).toBe(
      true
    )
  })

  /** The whole map still arrives, precomputed or not. */
  test('and writes the same headers the map function returns', () => {
    const written: Record<string, string> = {}

    securityHeaderWriter({}, true)('N', undefined, (name, value) => {
      written[name] = value
    })

    const built = securityHeaders({}, { secure: true, nonce: 'N', devOrigin: undefined })

    expect<string[]>(Object.keys(written).sort()).toEqual(Object.keys(built).sort())
    expect<string | undefined>(written['strict-transport-security']).toBe(
      built['strict-transport-security']
    )
  })

  /**
   * Development is left on the rebuilding path. `devOrigin` changes the policy
   * while Vite runs and is read from a file per response anyway.
   */
  test('while a dev origin still rebuilds, and reaches the policy', () => {
    const headers: Record<string, string> = {}

    securityHeaderWriter({}, false)('N', 'http://localhost:5173', (name, value) => {
      headers[name] = value
    })

    expect<boolean>(
      (headers['content-security-policy'] ?? '').includes('http://localhost:5173')
    ).toBe(true)
  })
})
