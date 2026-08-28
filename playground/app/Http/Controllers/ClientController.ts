import { view } from '@elvel/view'
import { Elysia } from 'elysia'
import { Client } from '../../../resources/views/pages/client.tsx'

/**
 * The browser client, and the endpoints its demo page calls.
 *
 * `HttpClientController` next door is the other direction — this application
 * calling somebody else. This one is `@elvel/client`: a browser talking to its
 * own backend, which is the half a code snippet cannot demonstrate. A file only
 * really uploads in a browser, and a request is only really cancelled there.
 *
 * The endpoints are deliberately dull — they echo what arrived, or answer a
 * chosen status. What is being exercised is the client, not the server.
 *
 * They sit under `/api` while the page does not, and that is the demo's first
 * lesson rather than an accident: the client prefixes `/api` unless told
 * otherwise, so `http.get('/check/browser/echo')` asks for
 * `/api/check/browser/echo`. Mounting them at the root instead made every button
 * answer `Not Found` — measured, before these paths moved.
 */
export default new Elysia({ name: 'client' })
  .get('/check/browser', () => view(Client, { title: 'Browser client' }))

  // -------------------------------------------------------- what it sends back

  /**
   * `body` from the context, never `request.json()`.
   *
   * Elysia has already parsed and consumed the stream by the time a handler runs,
   * so reading the request again throws `Body already used` — measured, on this
   * very page, before these two handlers were written this way.
   */
  .all('/api/check/browser/echo', ({ body, request }) => {
    const url = new URL(request.url)
    const type = request.headers.get('content-type') ?? ''

    return {
      method: request.method,
      query: url.search,
      accept: request.headers.get('accept'),
      contentType: type || null,
      csrf: request.headers.get('x-csrf-token') === null ? null : 'sent',
      body: body ?? null
    }
  })

  .post('/api/check/browser/upload', async ({ body, request }) => {
    const form = (body ?? {}) as Record<string, unknown>
    const file = form.report

    return {
      fields: Object.keys(form).sort(),
      filename: file instanceof File ? file.name : null,
      contents: file instanceof File ? await file.text() : null,
      /**
       * The reason the client must not set `content-type` itself.
       *
       * The boundary is chosen by the runtime once it has the form. A hand-written
       * `multipart/form-data` header survives and this `formData()` call then
       * throws — with nothing failing on the browser's side.
       */
      boundary: (request.headers.get('content-type') ?? '').includes('boundary=')
    }
  })

  // --------------------------------------------- statuses that mean something

  .post('/api/check/browser/created', ({ set }) => {
    set.status = 201
    set.headers.location = '/check/browser/invoices/7'

    return { id: 7 }
  })

  .get('/api/check/browser/slow', async () => {
    await Bun.sleep(3000)

    return { late: true }
  })

  .post('/api/check/browser/invalid', ({ set }) => {
    set.status = 422

    return {
      message: 'The given data was invalid.',
      errors: { total: ['Must be a number.'], due: ['Required.'] }
    }
  })

  .post('/api/check/browser/gone', ({ set }) => {
    set.status = 401

    return { message: 'Unauthenticated.' }
  })

  .post('/api/check/browser/locked', ({ set }) => {
    set.status = 423

    return { message: 'Password confirmation required.' }
  })
