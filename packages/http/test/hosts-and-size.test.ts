import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { bodySizePlugin } from '../src/body-size.ts'
import { hostsFor, hostWithoutPort, trustHostsPlugin } from '../src/hosts.ts'

/** Elysia's type differs per builder chain, so the shape is narrowed to what is used. */
const press = (
  app: { handle(request: Request): Promise<Response> },
  path: string,
  init: RequestInit = {}
): Promise<Response> => app.handle(new Request(`http://example.com${path}`, init))

describe('trusted hosts', () => {
  const app = (allow: string[]) =>
    new Elysia()
      .use(trustHostsPlugin({ allow }))
      .onError(({ error }) => new Response(String((error as Error).message), { status: 400 }))
      .get('/', () => 'ok')

  test('a host on the list is served', async () => {
    const response = await press(app(['example.com']), '/', {
      headers: { host: 'example.com' }
    })

    expect(response.status).toBe(200)
  })

  /**
   * The attack: this header is what a password-reset link is built from, so a
   * request carrying somebody else's host mails them a link to their own site.
   */
  test('a host that is not is refused', async () => {
    const response = await press(app(['example.com']), '/', {
      headers: { host: 'attacker.example' }
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('attacker.example')
  })

  test('the port is not part of the identity', async () => {
    const response = await press(app(['example.com']), '/', {
      headers: { host: 'example.com:8443' }
    })

    expect(response.status).toBe(200)
  })

  test('and neither is the case', async () => {
    const response = await press(app(['example.com']), '/', {
      headers: { host: 'EXAMPLE.com' }
    })

    expect(response.status).toBe(200)
  })

  describe('wildcards', () => {
    const wild = app(['*.example.com'])

    test('one level matches', async () => {
      expect((await press(wild, '/', { headers: { host: 'app.example.com' } })).status).toBe(200)
    })

    /** A wildcard crossing dots would admit a subdomain somebody else controls. */
    test('two levels do not', async () => {
      expect((await press(wild, '/', { headers: { host: 'a.b.example.com' } })).status).toBe(400)
    })

    test('and neither does the apex', async () => {
      expect((await press(wild, '/', { headers: { host: 'example.com' } })).status).toBe(400)
    })

    test('nor a host that merely ends the same way', async () => {
      expect((await press(wild, '/', { headers: { host: 'notexample.com' } })).status).toBe(400)
    })
  })

  test('hostWithoutPort leaves an IPv6 literal alone', () => {
    expect(hostWithoutPort('[::1]:3000')).toBe('[::1]')
    expect(hostWithoutPort('[::1]')).toBe('[::1]')
  })

  describe('the default list', () => {
    test('is the host in app.url, plus localhost', () => {
      expect(hostsFor('https://elvel.test:8443', [])).toEqual([
        'localhost',
        '127.0.0.1',
        '[::1]',
        'elvel.test'
      ])
    })

    test('a configured list wins outright', () => {
      expect(hostsFor('https://elvel.test', ['only.example'])).toEqual(['only.example'])
    })

    test('and a malformed app.url is not this plugin’s error to raise', () => {
      expect(hostsFor('not a url', [])).toEqual(['localhost', '127.0.0.1', '[::1]'])
    })
  })
})

describe('body size', () => {
  const app = (max: number, except: string[] = []) =>
    new Elysia()
      .use(bodySizePlugin({ max, except }))
      .onError(({ error }) => new Response(String((error as Error).message), { status: 413 }))
      .post('/', () => 'ok')
      .post('/uploads/avatar', () => 'ok')

  /**
   * The header is set by hand because a synthetic `Request` carries none, while
   * a real server request always does — measured: `Bun.serve` reports `50` for
   * the same body. So this is the ordinary path in production and the one worth
   * refusing before a byte is read.
   */
  test('a declared length over the limit is refused before the body is read', async () => {
    const response = await press(app(10), '/', {
      method: 'POST',
      body: 'x'.repeat(50),
      headers: { 'content-type': 'text/plain', 'content-length': '50' }
    })

    expect(response.status).toBe(413)
    expect(await response.text()).toContain('50 bytes')
  })

  test('one under it is served', async () => {
    const response = await press(app(100), '/', { method: 'POST', body: 'small' })

    expect(response.status).toBe(200)
  })

  /**
   * The plugin reads a declared length and nothing else. A chunked body is
   * refused by `maxRequestBodySize` at the socket, which is asserted against a
   * real server below because that is the only place it exists.
   */
  test('a chunked body is not the plugin’s job', async () => {
    const reading = new Elysia()
      .use(bodySizePlugin({ max: 8 }))
      .post('/', ({ body }) => `read:${String(body).length}`)

    const response = await press(reading, '/', {
      method: 'POST',
      body: chunks(4, 8),
      headers: { 'content-type': 'text/plain' },
      // @ts-expect-error `duplex` is required for a stream body and not yet typed.
      duplex: 'half'
    })

    expect(response.status).toBe(200)
  })

  test('an exempt path may exceed it', async () => {
    const response = await press(app(10, ['/uploads/*']), '/uploads/avatar', {
      method: 'POST',
      body: 'x'.repeat(50)
    })

    expect(response.status).toBe(200)
  })

  test('a GET is never measured', async () => {
    const served = new Elysia().use(bodySizePlugin({ max: 1 })).get('/', () => 'ok')

    expect((await press(served, '/')).status).toBe(200)
  })

  test('zero turns the check off', async () => {
    const response = await press(app(0), '/', { method: 'POST', body: 'x'.repeat(5000) })

    expect(response.status).toBe(200)
  })
})

/** A chunked body of `count` chunks of `size` bytes. */
function chunks(count: number, size: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let chunk = 0; chunk < count; chunk += 1) controller.enqueue(new Uint8Array(size))
      controller.close()
    }
  })
}

/**
 * The limit at the socket, against a real server.
 *
 * All three cases, because two of them look like holes until the third is
 * measured: a chunked body is refused when a handler reads it, and served when
 * none does — which costs nothing, since nothing buffered it.
 */
describe('maxRequestBodySize at the socket', () => {
  const post = (port: number | undefined, path: string, streamed: boolean) =>
    fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      body: streamed ? chunks(10, 32) : 'x'.repeat(320),
      // `duplex` is required for a stream body and not in the RequestInit type.
      ...(streamed ? ({ duplex: 'half' } as RequestInit) : {})
    })

  test('a declared length, a chunked body that is read, and one that is not', async () => {
    const app = new Elysia()
      .post('/reads', async ({ request }) => {
        await request.arrayBuffer().catch(() => undefined)

        return 'ok'
      })
      .post('/ignores', () => 'ok')

    app.listen({ port: 0, maxRequestBodySize: 16 })

    const port = app.server?.port

    try {
      expect((await post(port, '/reads', false)).status).toBe(413)
      expect((await post(port, '/reads', true)).status).toBe(413)

      // Served, and that is right: an unread body is never held.
      expect((await post(port, '/ignores', true)).status).toBe(200)
    } finally {
      app.stop()
    }
  })
})
