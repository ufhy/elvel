import { describe, expect, test } from 'bun:test'
import { Application, ExceptionHandler } from '@elvel/core'
import { Elysia } from 'elysia'
import { csrfToken } from '../src/csrf.ts'
import { HttpServiceProvider } from '../src/index.ts'
import { currentScope } from '../src/scope.ts'

/**
 * A real application, because the thing under test is where a hook runs.
 *
 * `session.csrf` is left on: the token this reads is the session's own either
 * way, and leaving the check in place is closer to what an application ships.
 */
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

/** An error handler that answers with whatever the session token reads as. */
function reportingToken(app: Application): void {
  app.instance(
    'exception.handler',
    new (class extends ExceptionHandler {
      override render(): Response {
        return new Response(JSON.stringify({ csrf: csrfToken() }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    })(app)
  )
}

const tokenOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { csrf: string }).csrf

describe('the session an error response renders with', () => {
  /**
   * The bug, and why it was worth fixing rather than documenting.
   *
   * A single-page application serves its document for every address the client
   * router owns, which means the exception handler renders it — and the document
   * carries the CSRF token the client sends back on every write. Read outside the
   * request scope, `csrfToken()` answers `''`: measured on a built demo, a deep
   * link booted the client with a token matching no session, and the failure did
   * not show until the first write came back 419.
   */
  test('a rendered 404 gets the request its own token', async () => {
    const app = await application()
    reportingToken(app)

    /**
     * Registered before the first request, not after.
     *
     * `app.handle` compiles the router on its first call, and a route added later
     * was not in it — so `/inside` fell through to the exception handler and this
     * test compared the error page with itself. It passed on the value and lied
     * about what produced it.
     */
    app.useRoutes(new Elysia().get('/inside', () => csrfToken()))

    const response = await app.handle(new Request('http://localhost/deep/link'))
    const token = await tokenOf(response)

    expect<number>(token.length).toBeGreaterThan(0)

    /**
     * The same token a handler would have read.
     *
     * Length alone would pass on a token invented per call, which is the failure
     * this is guarding: the client's copy has to be the session's, or the write
     * it is attached to is refused. The cookie ties both requests to one session.
     */
    const cookie = response.headers.get('set-cookie')

    expect<string | null>(cookie).not.toBeNull()

    const fromHandler = await app.handle(
      new Request('http://localhost/inside', {
        headers: { cookie: (cookie as string).split(';')[0] as string }
      })
    )

    expect<string>(await fromHandler.text()).toBe(token)
  })

  /** Two requests, two sessions — the scope is per request, not a global. */
  test('a second request with no cookie gets its own token', async () => {
    const app = await application()
    reportingToken(app)

    const first = await tokenOf(await app.handle(new Request('http://localhost/one')))
    const second = await tokenOf(await app.handle(new Request('http://localhost/two')))

    expect<number>(first.length).toBeGreaterThan(0)
    expect<boolean>(first === second).toBe(false)
  })
  /**
   * The flash a page rendered on this path leaves behind must survive to the next.
   *
   * `save()` ages the flash: it drops what was flashed last request and promotes
   * what was flashed this one. So a finisher that saves after something else
   * already saved throws away the message that save had just promoted — measured
   * as four smoke failures, `flash data survives exactly one request` among them,
   * the moment the error path started saving unconditionally. A redirect built on
   * this path persists its own session, which is exactly that case.
   */
  test('a message flashed by the error handler is still there next request', async () => {
    const app = await application()

    // Before the first request: `app.handle` compiles the router on its first
    // call, and a route added later is not in it.
    app.useRoutes(
      new Elysia().get('/after', () => String(currentScope()?.session.get('status') ?? 'nothing'))
    )

    app.instance(
      'exception.handler',
      new (class extends ExceptionHandler {
        override async render(): Promise<Response> {
          const scope = currentScope()

          scope?.session.flash('status', 'Saved.')

          // What `redirect().with(...)` does: persist, then answer.
          await scope?.session.save()

          return new Response('flashed', { status: 200 })
        }
      })(app)
    )

    const first = await app.handle(new Request('http://localhost/gone'))
    const cookie = (first.headers.get('set-cookie') as string).split(';')[0] as string

    const second = await app.handle(new Request('http://localhost/after', { headers: { cookie } }))

    expect<string>(await second.text()).toBe('Saved.')
  })
  /**
   * A refused write must not eat the message the previous one left.
   *
   * This is the smoke failure that produced `isDirty`: a `419` for a missing CSRF
   * token goes out through the error path, and saving there aged the flash a
   * successful write had just set. The page that was going to show it read
   * nothing. Nothing about the 419 changed the session, so nothing needed saving.
   */
  test('a 419 does not consume the flash data', async () => {
    const app = await application()

    app.useRoutes(
      new Elysia()
        .get('/token', () => csrfToken())
        .get('/status', () => String(currentScope()?.session.get('status') ?? 'nothing'))
        .post('/visit', () => {
          currentScope()?.session.flash('status', 'Visited!')

          return 'ok'
        })
    )

    const opened = await app.handle(new Request('http://localhost/token'))
    const token = await opened.text()
    const cookie = (opened.headers.get('set-cookie') as string).split(';')[0] as string

    const post = (body: Record<string, string>) =>
      app.handle(
        new Request('http://localhost/visit', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      )

    const read = async () =>
      await (
        await app.handle(new Request('http://localhost/status', { headers: { cookie } }))
      ).text()

    expect<number>((await post({ _token: token })).status).toBe(200)

    // The refused write is the one that used to age the flash on its way out.
    expect<number>((await post({})).status).toBe(419)

    expect<string>(await read()).toBe('Visited!')

    // And it is flash data, so the request after that no longer sees it.
    expect<string>(await read()).toBe('nothing')
  })
})
