import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ConnectionError, HttpClient, HttpResponse, RequestError } from '../src/index.ts'

/**
 * A real server on a real socket for most of this file.
 *
 * The fake is the last section and the smallest: a client tested only against
 * its own fake is a test of the fake. Retries, timeouts and connection failures
 * all behave differently over a socket than they do against a stub.
 */
let port = 0
let attempts = 0

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)

    switch (url.pathname) {
      case '/ok':
        return Response.json({ hello: 'world' })

      case '/echo':
        return Response.json({
          method: request.method,
          contentType: request.headers.get('content-type'),
          authorization: request.headers.get('authorization'),
          query: Object.fromEntries(url.searchParams),
          body: await request.text()
        })

      case '/status':
        return new Response('nope', { status: Number(url.searchParams.get('code') ?? 500) })

      case '/flaky': {
        // Fails twice, then succeeds — what a retry policy is for.
        attempts += 1

        return attempts < 3 ? new Response('busy', { status: 503 }) : Response.json({ attempts })
      }

      case '/slow':
        await Bun.sleep(3000)

        return new Response('late')

      case '/moved':
        return new Response(null, { status: 302, headers: { location: '/ok' } })

      case '/cookie':
        return new Response('set', { headers: { 'set-cookie': 'session=abc; Path=/' } })

      default:
        return new Response('not found', { status: 404 })
    }
  }
})

beforeAll(() => {
  port = server.port ?? 0
})

afterAll(() => {
  server.stop(true)
})

const at = (path: string) => `http://127.0.0.1:${port}${path}`
const client = () => new HttpClient()

describe('making a request', () => {
  test('reads a JSON body and its status', async () => {
    const response = await client().get(at('/ok'))

    expect(response.status).toBe(200)
    expect(response.ok()).toBe(true)
    expect(response.successful()).toBe(true)
    expect(response.json<{ hello: string }>()).toEqual({ hello: 'world' })
  })

  test('json() answers undefined rather than throwing on a non-JSON body', async () => {
    const response = await client().get(at('/missing'))

    expect(response.notFound()).toBe(true)
    expect(response.json()).toBeUndefined()
    expect(response.body).toBe('not found')
  })

  test('posts JSON, and sets the content type for you', async () => {
    const response = await client().post(at('/echo'), { name: 'Ada' })
    const echoed = response.json<{ contentType: string; body: string; method: string }>()

    expect(echoed?.method).toBe('POST')
    expect(echoed?.contentType).toBe('application/json')
    expect(JSON.parse(echoed?.body ?? '{}')).toEqual({ name: 'Ada' })
  })

  test('posts a form', async () => {
    const response = await client().asForm(at('/echo'), { name: 'Ada', role: 'admin' })
    const echoed = response.json<{ contentType: string; body: string }>()

    expect(echoed?.contentType).toBe('application/x-www-form-urlencoded')
    expect(echoed?.body).toBe('name=Ada&role=admin')
  })

  test('carries a token and query parameters', async () => {
    const response = await client().withToken('abc123').withQuery({ page: '2' }).get(at('/echo'))

    const echoed = response.json<{ authorization: string; query: Record<string, string> }>()

    expect(echoed?.authorization).toBe('Bearer abc123')
    expect(echoed?.query).toEqual({ page: '2' })
  })

  test('a base URL is reused without leaking into the base instance', async () => {
    const api = client().baseUrl(`http://127.0.0.1:${port}`)

    expect((await api.get('/ok')).ok()).toBe(true)
    // Immutable: the second call is not carrying the first one's query.
    expect((await api.withQuery({ a: '1' }).get('/echo')).json<{ query: object }>()?.query).toEqual(
      {
        a: '1'
      }
    )
    expect((await api.get('/echo')).json<{ query: object }>()?.query).toEqual({})
  })

  test('reads set-cookie', async () => {
    expect((await client().get(at('/cookie'))).cookies()).toEqual({ session: 'abc' })
  })

  test('follows a redirect by default, and not when told', async () => {
    expect((await client().get(at('/moved'))).json<{ hello: string }>()).toEqual({
      hello: 'world'
    })

    const manual = await client().withoutRedirecting().get(at('/moved'))

    expect(manual.status).toBe(302)
    expect(manual.header('location')).toBe('/ok')
    // A 3xx is a result, not a failure — `throw()` must leave it alone.
    expect(manual.failed()).toBe(false)
    expect(() => manual.throw()).not.toThrow()
  })
})

describe('failures', () => {
  test('a 4xx is a failure but does not throw on its own', async () => {
    const response = await client().get(at('/status?code=422'))

    expect(response.failed()).toBe(true)
    expect(response.clientError()).toBe(true)
    expect(response.unprocessable()).toBe(true)
  })

  test('throw() puts the body in the message', async () => {
    const response = await client().get(at('/status?code=500'))

    // Without the body, the message sends you to a log for what was already here.
    expect(() => response.throw()).toThrow(/500 from/)
    expect(() => response.throw()).toThrow(/nope/)
    expect(() => response.throw()).toThrow(RequestError)
  })

  test('throwIf and throwUnless take a predicate', async () => {
    const response = await client().get(at('/status?code=404'))

    expect(() => response.throwIf((one) => one.notFound())).toThrow(RequestError)
    expect(() => response.throwIf(false)).not.toThrow()
    expect(() => response.throwUnless((one) => one.ok())).toThrow(RequestError)
  })

  test('throwOnFailure throws without a call site saying so', async () => {
    await expect(client().throwOnFailure().get(at('/status?code=500'))).rejects.toThrow(
      RequestError
    )
  })

  test('an unreachable host is a ConnectionError, not a response', async () => {
    // Port 1 is reserved and nothing listens there.
    await expect(client().timeout(2000).get('http://127.0.0.1:1/nothing')).rejects.toThrow(
      ConnectionError
    )
  })

  test('a timeout cancels rather than waiting', async () => {
    const started = Date.now()

    await expect(client().timeout(200).get(at('/slow'))).rejects.toThrow(ConnectionError)
    // The handler sleeps three seconds; the abort must not wait for it.
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('retrying', () => {
  test('repeats a 5xx until it succeeds', async () => {
    attempts = 0
    const response = await client().retry(4, 10).get(at('/flaky'))

    expect(response.ok()).toBe(true)
    expect(response.json<{ attempts: number }>()?.attempts).toBe(3)
  })

  test('gives up and throws when the attempts run out', async () => {
    attempts = 0
    await expect(client().retry(2, 5).get(at('/flaky'))).rejects.toThrow(RequestError)
  })

  test('hands the failure back instead when told not to throw', async () => {
    attempts = 0
    const response = await client().retry(2, 5, undefined, false).get(at('/flaky'))

    expect(response.status).toBe(503)
  })

  /**
   * The default policy is narrow on purpose.
   *
   * A 422 is the server saying the body will never be accepted; repeating it
   * sends the same invalid request again. Retrying a 401 is how an account gets
   * locked out.
   */
  test('does not repeat a 4xx', async () => {
    const seen: number[] = []
    const counted = new HttpClient()
    counted.fake({
      '*': (attempt) => {
        seen.push(1)

        return new HttpResponse(new Response('no', { status: 422 }), 'no', attempt.url)
      }
    })

    await expect(counted.retry(3, 0).get('https://example.com/x')).rejects.toThrow(RequestError)
    expect(seen.length).toBe(1)
  })

  test('a callback can widen what is worth repeating', async () => {
    const seen: number[] = []
    const counted = new HttpClient()
    counted.fake({
      '*': (attempt) => {
        seen.push(1)

        return new HttpResponse(new Response('no', { status: 422 }), 'no', attempt.url)
      }
    })

    await expect(
      counted
        .retry(3, 0, (_error, response) => response?.status === 422)
        .get('https://example.com/x')
    ).rejects.toThrow(RequestError)

    expect(seen.length).toBe(3)
  })

  test('the delay can grow with the attempt', async () => {
    const waits: number[] = []
    attempts = 0

    const started = Date.now()
    await client()
      .retry(3, (attempt) => {
        waits.push(attempt)

        return attempt * 20
      })
      .get(at('/flaky'))

    expect<number[]>(waits).toEqual([1, 2])
    // 20ms then 40ms, so at least 60 with no upper bound asserted.
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })
})

describe('a pool', () => {
  test('runs concurrently and keys the results as declared', async () => {
    const started = Date.now()

    const results = await client().pool({
      first: (http) => http.get(at('/ok')),
      second: (http) => http.get(at('/echo')),
      broken: (http) => http.timeout(1000).get('http://127.0.0.1:1/nothing')
    })

    expect<string[]>(Object.keys(results)).toEqual(['first', 'second', 'broken'])
    expect((results.first as HttpResponse).ok()).toBe(true)
    // A failure is reported in place; the other two still answered.
    expect(results.broken).toBeInstanceOf(ConnectionError)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('faking', () => {
  test('answers without a network, and records what was asked', async () => {
    const http = new HttpClient()
    http.fake({ 'https://api.example.com/*': { body: { ok: true } } })

    const response = await http.get('https://api.example.com/users')

    expect(response.json<{ ok: boolean }>()).toEqual({ ok: true })
    expect(response.header('content-type')).toBe('application/json')
    http.assertSent('https://api.example.com/users').assertSentCount(1)
  })

  test('a wildcard does not match more than it says', async () => {
    const http = new HttpClient()
    http.fake({ 'https://api.example.com/users': 'exact' }).preventStrayRequests()

    expect((await http.get('https://api.example.com/users')).body).toBe('exact')
    await expect(http.get('https://api.example.com/users/7')).rejects.toThrow(/no fake matched/)
  })

  test('a sequence answers differently, then repeats the last', async () => {
    const http = new HttpClient()
    http.sequence('https://api.example.com/*', [
      { status: 503 },
      { status: 503 },
      { body: { done: true } }
    ])

    const response = await http.retry(4, 0).get('https://api.example.com/thing')

    expect(response.json<{ done: boolean }>()).toEqual({ done: true })
    http.assertSentCount(3)
  })

  test('a stray request is refused when asked', async () => {
    const http = new HttpClient()
    http.fake({ 'https://api.example.com/*': 'ok' }).preventStrayRequests()

    await expect(http.get('https://elsewhere.test/x')).rejects.toThrow(/no fake matched/)
  })

  test('the assertions name what was actually sent', async () => {
    const http = new HttpClient()
    http.fake({ '*': 'ok' })

    await http.get('https://api.example.com/one')

    expect(() => http.assertSent('https://api.example.com/two')).toThrow(/Sent: \[GET https/)
    expect(() => http.assertNothingSent()).toThrow(/Expected 0 request/)
    expect(() => http.assertNotSent('*')).toThrow(/Expected no request/)
  })

  test('order can be asserted', async () => {
    const http = new HttpClient()
    http.fake({ '*': 'ok' })

    await http.get('https://api.example.com/first')
    await http.get('https://api.example.com/second')

    http.assertSentInOrder(['*/first', '*/second'])
    expect(() => http.assertSentInOrder(['*/second', '*/first'])).toThrow(/after the previous one/)
  })

  test('stopFaking clears the tape as well as the stubs', async () => {
    const http = new HttpClient()
    http.fake({ '*': 'ok' })
    await http.get('https://api.example.com/x')

    http.stopFaking()

    expect(http.isFaking).toBe(false)
    http.assertNothingSent()
  })
})

describe('recording', () => {
  /**
   * The leak this caught.
   *
   * Recording every request unconditionally looks harmless and grows without
   * bound: a server running for a week keeps every outbound call it ever made,
   * and nothing reads them. Found in the playground, where a singleton client had
   * accumulated ten requests before a test asserted on one.
   */
  test('nothing is recorded until asked', async () => {
    const http = new HttpClient()

    await http.get(at('/ok'))

    expect(http.recorded().length).toBe(0)
  })

  test('record() keeps them without faking', async () => {
    const http = new HttpClient()
    http.record()

    await http.get(at('/ok'))

    expect(http.recorded().length).toBe(1)
    http.assertSent('*/ok')
  })

  test('fake() clears whatever was recorded before it', async () => {
    const http = new HttpClient()
    http.record()
    await http.get(at('/ok'))

    http.fake({ '*': 'stubbed' })

    // Otherwise an assertion describes the whole process rather than this test.
    http.assertNothingSent()

    await http.get('https://api.example.test/x')
    http.assertSentCount(1)
  })
})
