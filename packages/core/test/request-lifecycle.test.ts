import { describe, expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { Application } from '../src/application.ts'
import { ExceptionHandler } from '../src/exceptions.ts'

const root = await mkdtemp(join(tmpdir(), 'elvel-scopes-'))

/**
 * A package's scope, in miniature.
 *
 * The real ones hold a session and a signed-in user. What they have in common is
 * the shape this stands in for: an `AsyncLocalStorage` entered from a synchronous
 * hook, read by a helper that takes no arguments.
 */
const storage = new AsyncLocalStorage<{ who: string }>()

const who = () => storage.getStore()?.who ?? 'nobody'

const application = () => {
  const app = new Application(root)

  app.config.set('app.env', 'testing')
  app.handleExceptions()

  return app
}

describe('the lifecycle an error response has to run itself', () => {
  /**
   * The failure this exists for.
   *
   * Without a restorer the exception handler reads the scope as empty, which is
   * how a document rendered for a deep link ended up saying "guest" for a visitor
   * whose cookie the very next endpoint accepted.
   */
  test('without one, a rendered error sees nothing', async () => {
    const app = application()

    app.instance(
      'exception.handler',
      new (class extends ExceptionHandler {
        override render(): Response {
          return new Response(who(), { status: 200 })
        }
      })(app)
    )

    const response = await app.handle(new Request('http://localhost/missing'))

    expect<string>(await response.text()).toBe('nobody')
  })

  test('with one, the same render sees the request its scope belongs to', async () => {
    const app = application()
    let resolved = ''

    /**
     * A preparation, then the scope — the arrangement an application actually
     * uses, and the one worth testing: reading a session is async and entering
     * its scope cannot be, so `enter` runs *after* an `await`. `enterWith` still
     * reaches the renderer from there, because both are the same execution.
     */
    app
      .make('request.lifecycle')
      .preparing(async (request) => {
        await Bun.sleep(1)

        resolved = new URL(request.url).pathname
      })
      .entering(() => {
        storage.enterWith({ who: resolved })
      })

    app.instance(
      'exception.handler',
      new (class extends ExceptionHandler {
        /** Async on purpose: `enterWith` has to survive the `await` before this. */
        override async render(): Promise<Response> {
          await Bun.sleep(1)

          return new Response(who(), { status: 200 })
        }
      })(app)
    )

    const response = await app.handle(new Request('http://localhost/deep/link'))

    expect<string>(await response.text()).toBe('/deep/link')
    expect<number>(response.status).toBe(200)
  })

  /**
   * The constraint that made this worth a test rather than a patch.
   *
   * Restoring a scope must not answer the request. Anything registered here runs
   * while an error is on its way out, and a hook that returns a value in Elysia's
   * error pipeline pins the response — so a 500 that came back as anything else
   * would mean the machinery describing the error had replaced it.
   */
  test('a 500 is still a 500', async () => {
    const app = application()
    const seen: string[] = []

    app.make('request.lifecycle').entering((request) => {
      seen.push(new URL(request.url).pathname)
    })

    app.useRoutes(
      new Elysia().get('/boom', () => {
        throw new Error('the database is on fire')
      })
    )

    const response = await app.handle(new Request('http://localhost/boom'))

    expect<number>(response.status).toBe(500)
    expect<string[]>(seen).toEqual(['/boom'])
  })

  /**
   * A restorer that throws is swallowed.
   *
   * It runs while an error is already being reported. Letting it through would
   * replace the error a developer is trying to read with one about the machinery
   * that was trying to describe it — and the cost of swallowing is one value
   * reading empty, which is the behaviour without any of this.
   */
  test('one that throws does not take the error page with it', async () => {
    const app = application()
    let second = false

    app.make('request.lifecycle').entering(() => {
      throw new Error('this restorer is broken')
    })

    app.make('request.lifecycle').entering(() => {
      second = true
    })

    const response = await app.handle(new Request('http://localhost/missing'))

    expect<number>(response.status).toBe(404)
    expect<boolean>(second).toBe(true)
  })

  /**
   * What the session plugin needs: the finished response, to add a header to.
   *
   * Measured before any of this existed — an unmatched request came back with no
   * `Set-Cookie` at all, because re-issuing it lives in `onAfterHandle`.
   */
  test('a finisher sees the response and can add to it', async () => {
    const app = application()
    const seen: number[] = []

    app.make('request.lifecycle').finishing((request, response) => {
      seen.push(response.status)
      response.headers.append('set-cookie', `where=${new URL(request.url).pathname}`)
    })

    const response = await app.handle(new Request('http://localhost/missing'))

    expect<number[]>(seen).toEqual([404])
    expect<string | null>(response.headers.get('set-cookie')).toBe('where=/missing')
  })

  /** An async finisher that rejects is swallowed like the rest. */
  test('a finisher that rejects does not take the error page with it', async () => {
    const app = application()

    app.make('request.lifecycle').finishing(async () => {
      await Bun.sleep(1)

      throw new Error('the store is gone')
    })

    expect<number>((await app.handle(new Request('http://localhost/missing'))).status).toBe(404)
  })
})

await rm(root, { recursive: true, force: true })
