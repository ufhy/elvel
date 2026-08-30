import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '@elvel/core'
import { Elysia } from 'elysia'
import { HttpServiceProvider } from '../src/index.ts'
import { currentScope } from '../src/scope.ts'

/**
 * The CSRF hook as the pipeline actually runs it.
 *
 * `csrf.test.ts` covers `tokensMatch` on its own. What is worth guarding here is
 * the hook around it: it now decides on the method before it builds anything, and
 * it reads one header instead of copying all of them. Both are shortcuts, and a
 * shortcut is only safe if the answers are unchanged — so these ask for the
 * answers rather than for the shape of the code.
 */
async function serve(): Promise<{
  handle: (request: Request) => Promise<Response>
  close: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'elvel-csrf-'))
  const app = new Application(root)

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', 'testing')
  app.config.set('session', { driver: 'memory', csrfExcept: ['/webhooks/*'] })

  await app.register(HttpServiceProvider)
  await app.boot()
  app.handleExceptions()

  app.useRoutes(
    new Elysia()
      .get('/token', () => currentScope()?.session.ensureToken() ?? '')
      .post('/save', () => 'saved')
      .post('/webhooks/stripe', () => 'received')
  )

  return {
    handle: (request) => app.handle(request),
    close: () => rm(root, { recursive: true, force: true })
  }
}

/**
 * A token and the cookie it belongs to; a token alone authorises nothing.
 *
 * `ensureToken()` rather than `token()`, because a session only gets a token when
 * a page asks for one — and only then is it written and given a cookie.
 */
async function credentials(
  handle: (request: Request) => Promise<Response>
): Promise<{ token: string; cookie: string }> {
  const response = await handle(new Request('http://localhost/token'))
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

  return { token: await response.text(), cookie }
}

describe('the CSRF hook', () => {
  test('lets a read through without a token', async () => {
    const { handle, close } = await serve()

    const response = await handle(new Request('http://localhost/token'))

    expect<number>(response.status).toBe(200)

    /**
     * And a HEAD to a route that only answers POST is still a 404 rather than a
     * 419 — the method exit runs before anything CSRF-shaped is considered.
     */
    const head = await handle(new Request('http://localhost/save', { method: 'HEAD' }))

    expect<boolean>(head.status === 419).toBe(false)

    await close()
  })

  test('and refuses a write without one', async () => {
    const { handle, close } = await serve()
    const { cookie } = await credentials(handle)

    const response = await handle(
      new Request('http://localhost/save', { method: 'POST', headers: { cookie } })
    )

    expect<number>(response.status).toBe(419)

    await close()
  })

  /**
   * The header lookup is now a single `Headers.get`, which is case-insensitive.
   * `tokenFromRequest` accepts either spelling, so a client sending Laravel's
   * uppercase `X-CSRF-TOKEN` must still be understood.
   */
  test('accepting the token from either spelling of the header', async () => {
    for (const name of ['x-csrf-token', 'X-CSRF-TOKEN']) {
      const { handle, close } = await serve()
      const { token, cookie } = await credentials(handle)

      const response = await handle(
        new Request('http://localhost/save', {
          method: 'POST',
          headers: { cookie, [name]: token }
        })
      )

      expect<number>(response.status).toBe(200)

      await close()
    }
  })

  test('or from the body, which is where a form puts it', async () => {
    const { handle, close } = await serve()
    const { token, cookie } = await credentials(handle)

    const body = new URLSearchParams({ _token: token })
    const response = await handle(
      new Request('http://localhost/save', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body
      })
    )

    expect<number>(response.status).toBe(200)

    await close()
  })

  test('and an excepted path still needs nothing at all', async () => {
    const { handle, close } = await serve()

    const response = await handle(
      new Request('http://localhost/webhooks/stripe', { method: 'POST' })
    )

    expect<number>(response.status).toBe(200)

    await close()
  })
})
