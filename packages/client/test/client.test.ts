import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { call, embedded, http, Invalid, send, Unauthenticated } from '../src/index.ts'

/**
 * The half that would be written insecurely by hand.
 *
 * Anybody assembling this themselves reaches for `localStorage.setItem('token',
 * …)`, because that is what every tutorial shows — and then one XSS is a stolen
 * session rather than a bad afternoon. The point of shipping it is that the
 * decision is made once, here, where it can be tested.
 */
const originalFetch = globalThis.fetch
const originalDocument = (globalThis as { document?: unknown }).document

afterEach(() => {
  globalThis.fetch = originalFetch
  ;(globalThis as { document?: unknown }).document = originalDocument
})

/** What the last request was, so the headers can be read back. */
function record(answer: { status?: number; body?: unknown } = {}) {
  const seen: { url: string; init: RequestInit } = { url: '', init: {} }

  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen.url = url
    seen.init = init

    const status = answer.status ?? 200

    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(answer.body ?? { ok: true }), { status })
    )
  }) as typeof fetch

  return seen
}

/** A document with a payload in it, the way the server rendered one. */
function withPayload(json: string | null) {
  ;(globalThis as { document?: unknown }).document = {
    querySelector: () => (json === null ? null : { textContent: json })
  }
}

describe('the payload the server embedded', () => {
  test('is read from the inert script tag', () => {
    withPayload('{"user":{"name":"Ada"},"csrf":"tok"}')

    expect<unknown>(embedded<{ user: { name: string } }>().user?.name).toBe('Ada')
  })

  /**
   * Empty rather than thrown, for two cases that are not errors.
   *
   * A shell embeds nothing on purpose. And Vite's own dev origin serves no
   * document at all, which is why opening it shows a blank page — one address
   * serves the application, and it is the server's.
   */
  test('is empty when there is nothing to read', () => {
    withPayload(null)

    expect<Record<string, unknown>>(embedded()).toEqual({})
  })
})

describe('what every request carries', () => {
  test('the cookie, and no Authorization header anywhere', async () => {
    withPayload('{"csrf":"tok"}')

    const seen = record()

    await call('/user')

    expect<string>(seen.url).toBe('/api/user')
    expect<RequestCredentials | undefined>(seen.init.credentials).toBe('same-origin')

    const headers = seen.init.headers as Record<string, string>

    /**
     * `accept`, and it is not decoration.
     *
     * The `auth` middleware answers a guest with 401 to a client that asked for
     * JSON and a redirect to anything else. Without this header an expired session
     * sent `fetch` following a 302 to a document, and `JSON.parse` failed on HTML
     * — a parse error standing in for "you are signed out".
     */
    expect<string | undefined>(headers.accept).toBe('application/json')
    expect<boolean>('authorization' in headers).toBe(false)
  })

  test('the token on a write, and not on a read', async () => {
    withPayload('{"csrf":"tok"}')

    const write = record()
    await call('/invoices', { method: 'POST', body: { customer: 'Ada' } })

    expect<string | undefined>((write.init.headers as Record<string, string>)['x-csrf-token']).toBe(
      'tok'
    )

    const read = record()
    await call('/invoices')

    // Harmless and pointless: the server only checks writes.
    expect<boolean>('x-csrf-token' in (read.init.headers as Record<string, string>)).toBe(false)
  })

  /** A shell carries no token, so one can be supplied per call. */
  test('a token given by the caller wins', async () => {
    withPayload('{}')

    const seen = record()

    await call('/invoices', { method: 'POST', body: {}, token: 'fetched' })

    expect<string | undefined>((seen.init.headers as Record<string, string>)['x-csrf-token']).toBe(
      'fetched'
    )
  })

  test('a query is a query, not a hand-built string', async () => {
    withPayload('{}')

    const seen = record()

    await call('/invoices', { query: { status: 'sent', search: 'a b' } })

    expect<string>(seen.url).toBe('/api/invoices?status=sent&search=a+b')
  })
})

describe('what an answer means', () => {
  test('401 is one type a router can act on', async () => {
    withPayload('{}')
    record({ status: 401 })

    await expect(call('/user')).rejects.toBeInstanceOf(Unauthenticated)
  })

  test('422 carries the messages per field', async () => {
    withPayload('{}')
    record({ status: 422, body: { message: 'No.', errors: { customer: ['Required.'] } } })

    try {
      await call('/invoices', { method: 'POST', body: {} })
      expect<boolean>(true).toBe(false)
    } catch (error) {
      expect<boolean>(error instanceof Invalid).toBe(true)
      expect<string[]>((error as Invalid).errors.customer as string[]).toEqual(['Required.'])
    }
  })

  test('204 is not a parse error', async () => {
    withPayload('{}')
    record({ status: 204 })

    // `JSON.parse('')` throws, and a delete that worked must not look like a failure.
    expect<unknown>(await call('/invoices/1', { method: 'DELETE' })).toEqual({})
  })

  test('anything else carries the server’s message', async () => {
    withPayload('{}')
    record({ status: 500, body: { message: 'The database is on fire.' } })

    await expect(call('/invoices')).rejects.toThrow('The database is on fire.')
  })
})

describe('where a call is addressed', () => {
  test('under /api by default, because that is what answers a client with JSON', () => {
    const seen = record()

    void call('/invoices')

    expect(seen.url).toBe('/api/invoices')
  })

  test('and nowhere in particular when the prefix is cleared', () => {
    const seen = record()

    /**
     * A form posts to the address it names. `/sign-in` and `/settings/profile` are
     * the same addresses a browser navigates to — prefixing them would 404.
     */
    void call('/sign-in', { method: 'POST', body: {}, prefix: '' })

    expect(seen.url).toBe('/sign-in')
  })
})

describe('the query, in the shapes callers actually have', () => {
  test('an array repeats its key, and empties are left out', async () => {
    withPayload('{}')

    const seen = record()

    await call('/invoices', {
      query: { status: 'paid', ids: [1, 2], page: 2, live: true, cursor: null, note: undefined }
    })

    /**
     * `null` and `undefined` are dropped rather than sent as their own names.
     *
     * `URLSearchParams` unaided writes `cursor=null`, which is a filter for the
     * word "null" — the one thing an absent filter must not become.
     *
     * The repeated key is what this sends; what the other end makes of it is a
     * separate question, measured against a running application: the query parser
     * answers strings and the last value wins, for `ids=` and `ids[]=` alike, so
     * reading an array back needs the route to declare one.
     */
    expect<string>(seen.url).toBe('/api/invoices?status=paid&ids=1&ids=2&page=2&live=true')
  })
})

describe('the verbs', () => {
  test('name the method rather than passing it in options', async () => {
    withPayload('{}')

    const seen = record()

    await http.patch('/invoices/7', { body: { paid: true } })

    expect<string>(seen.url).toBe('/api/invoices/7')
    expect<string | undefined>(seen.init.method).toBe('PATCH')

    await http.delete('/invoices/7')

    expect<string | undefined>(seen.init.method).toBe('DELETE')
  })

  test('and a caller’s own header wins over a default', async () => {
    withPayload('{}')

    const seen = record()

    await http.get('/invoices', { headers: { accept: 'application/vnd.api+json' } })

    const headers = seen.init.headers as Record<string, string>

    expect<string>(headers.accept as string).toBe('application/vnd.api+json')
  })
})

describe('the whole answer', () => {
  test('send hands back the status and the headers', async () => {
    withPayload('{}')

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 7 }), {
          status: 201,
          headers: { 'content-type': 'application/json', location: '/api/invoices/7' }
        })
      )) as unknown as typeof fetch

    const answer = await send<{ id: number }>('/invoices', { method: 'POST', body: {} })

    expect<number>(answer.status).toBe(201)
    expect<string | null>(answer.headers.get('location')).toBe('/api/invoices/7')
    expect<number>(answer.data.id).toBe(7)
  })
})

/**
 * The two that a stubbed `fetch` cannot answer, against a real server.
 *
 * `FormData` is about the boundary the runtime writes — only the far end can say
 * whether it parsed. And an aborted request is about one that never finishes, which
 * a stub resolving immediately cannot be.
 */
describe('against a socket', () => {
  let server: ReturnType<typeof Bun.serve>
  let at = ''

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url)

        if (pathname === '/api/upload') {
          const form = await request.formData()
          const file = form.get('report')

          return Response.json({
            fields: [...form.keys()].sort(),
            contents: file instanceof File ? await file.text() : null,
            boundary: (request.headers.get('content-type') ?? '').includes('boundary=')
          })
        }

        await Bun.sleep(2_000)

        return Response.json({ late: true })
      }
    })

    at = `http://localhost:${server.port}/api`
  })

  afterAll(() => server.stop(true))

  test('FormData travels as it is, and the runtime writes the boundary', async () => {
    const form = new FormData()

    form.append('report', new Blob(['line one']), 'report.txt')
    form.append('note', 'from the tests')

    const answer = await http.post<{ fields: string[]; contents: string; boundary: boolean }>(
      '/upload',
      { prefix: at, body: form }
    )

    expect<string[]>(answer.fields).toEqual(['note', 'report'])
    expect<string>(answer.contents).toBe('line one')

    /**
     * The boundary is why `content-type` is not set for a form.
     *
     * Only the runtime knows it, and only once it has the form. A hand-set
     * `multipart/form-data` survives and the far end then cannot parse the body,
     * with nothing failing on this side.
     */
    expect<boolean>(answer.boundary).toBe(true)
  })

  test('an aborted request rejects rather than landing late', async () => {
    const controller = new AbortController()
    const inFlight = http.get('/slow', { prefix: at, signal: controller.signal })

    controller.abort()

    expect(inFlight).rejects.toThrow()
  })
})
