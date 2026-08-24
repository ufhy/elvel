import { afterEach, describe, expect, test } from 'bun:test'
import { call, embedded, Invalid, Unauthenticated } from '../src/client.ts'

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
