import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { methodField, methodOverridePlugin } from '../src/method-override.ts'

/**
 * Routes that report which handler ran.
 *
 * The whole question is which one Elysia picks, so every handler answers with its
 * own verb and the assertions read like the router's decision.
 */
function application(options: Parameters<typeof methodOverridePlugin>[1] = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: the plugin re-enters this instance
  const app: any = new Elysia()
    .use(methodOverridePlugin((request) => app.handle(request), options))
    .get('/thing', () => 'GET')
    .post('/thing', async ({ request }) => `POST ${await request.text()}`)
    .put('/thing', async ({ request }) => `PUT ${await request.text()}`)
    .patch('/thing', () => 'PATCH')
    .delete('/thing', () => 'DELETE')

  return app as Elysia
}

const form = (body: string) =>
  new Request('http://localhost/thing', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })

describe('spoofing a method from a form', () => {
  test('reaches the PUT route', async () => {
    const app = application()
    await app.modules

    expect(await (await app.handle(form('_method=PUT&name=Ada'))).text()).toStartWith('PUT')
  })

  test('and PATCH and DELETE', async () => {
    const app = application()
    await app.modules

    expect(await (await app.handle(form('_method=PATCH'))).text()).toBe('PATCH')
    expect(await (await app.handle(form('_method=DELETE'))).text()).toBe('DELETE')
  })

  test('is case-insensitive', async () => {
    const app = application()
    await app.modules

    expect(await (await app.handle(form('_method=patch'))).text()).toBe('PATCH')
  })

  /**
   * The body has to survive.
   *
   * `_method` is read from a clone, because a `Request` body is a stream that can
   * be consumed once — reading it in the plugin and forgetting to pass it on
   * would leave every spoofed handler with nothing to validate.
   */
  test('the body reaches the handler intact', async () => {
    const app = application()
    await app.modules

    const answer = await (await app.handle(form('_method=PUT&name=Ada&role=admin'))).text()

    expect(answer).toBe('PUT _method=PUT&name=Ada&role=admin')
  })

  test('a plain POST is untouched', async () => {
    const app = application()
    await app.modules

    expect(await (await app.handle(form('name=Ada'))).text()).toBe('POST name=Ada')
  })

  test('the header form works, and wins over the field', async () => {
    const app = application()
    await app.modules

    const response = await app.handle(
      new Request('http://localhost/thing', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-http-method-override': 'DELETE'
        },
        body: '_method=PATCH'
      })
    )

    expect(await response.text()).toBe('DELETE')
  })

  test('multipart carries it too', async () => {
    const app = application()
    await app.modules

    const body = new FormData()
    body.set('_method', 'PATCH')
    body.set('name', 'Ada')

    const response = await app.handle(
      new Request('http://localhost/thing', { method: 'POST', body })
    )

    expect(await response.text()).toBe('PATCH')
  })
})

describe('what it refuses', () => {
  /**
   * The rule that matters.
   *
   * A POST turned into a GET would be a state-changing request wearing the
   * clothes of a safe one: cacheable by a proxy, repeatable by a browser, and
   * exempt from every "this method is safe" assumption downstream. Symfony
   * refuses the same four.
   */
  test('refuses GET, HEAD, CONNECT and TRACE', async () => {
    const app = application()
    await app.modules

    for (const method of ['GET', 'HEAD', 'CONNECT', 'TRACE']) {
      const answer = await (await app.handle(form(`_method=${method}`))).text()

      expect(answer).toStartWith('POST')
    }
  })

  test('refuses anything not on the allow list', async () => {
    const app = application({ allow: ['PATCH'] })
    await app.modules

    expect(await (await app.handle(form('_method=PATCH'))).text()).toBe('PATCH')
    // PUT is spoofable by default and not here.
    expect(await (await app.handle(form('_method=PUT'))).text()).toStartWith('POST')
  })

  test('ignores a query parameter unless asked', async () => {
    const off = application()
    const on = application({ fromQuery: true })
    await Promise.all([off.modules, on.modules])

    const request = () =>
      new Request('http://localhost/thing?_method=DELETE', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: ''
      })

    expect(await (await off.handle(request())).text()).toStartWith('POST')
    expect(await (await on.handle(request())).text()).toBe('DELETE')
  })

  test('a GET carrying _method is left alone', async () => {
    const app = application()
    await app.modules

    // Only a POST may be overridden; a GET with the field is just a GET.
    const response = await app.handle(new Request('http://localhost/thing?_method=DELETE'))

    expect(await response.text()).toBe('GET')
  })

  test('does not loop when the spoofed request still carries the field', async () => {
    const app = application()
    await app.modules

    // The marker header is what stops the re-entered request being rewritten
    // again; without it this recurses until the stack gives out.
    const response = await app.handle(form('_method=PUT&_method=PUT'))

    expect(response.status).toBe(200)
    expect(await response.text()).toStartWith('PUT')
  })
})

describe('methodField', () => {
  test('writes the hidden input a form needs', () => {
    expect(methodField('patch')).toBe('<input type="hidden" name="_method" value="PATCH" />')
  })

  test('strips anything that is not a method name', () => {
    // The value is interpolated into markup, so nothing but letters may survive.
    expect(methodField('PUT"><script>')).toBe(
      '<input type="hidden" name="_method" value="PUTSCRIPT" />'
    )
  })
})
