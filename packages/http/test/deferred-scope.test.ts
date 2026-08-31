import { describe, expect, test } from 'bun:test'
import { Application, defer, deferredCount, flushDeferred } from '@elvel/core'
import { Elysia } from 'elysia'
import { HttpServiceProvider } from '../src/index.ts'

/**
 * `defer()` belongs to the request that called it.
 *
 * The queue was one module-level array shared by every request, and two things
 * went wrong with it under any concurrency at all. `key` deduplicated **across**
 * requests, so two callers deferring `{ key: 'refresh' }` at the same moment ran it
 * once and one of them lost its work silently. And whichever request finished
 * first flushed everything, so a slow request's callbacks ran before it had
 * finished, reported through a different request's exception handler.
 *
 * Both were measured on a real server rather than reasoned about: two overlapping
 * requests, and only one callback ran.
 */
async function serve(ran: string[]): Promise<{
  handle: (request: Request) => Promise<Response>
}> {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', 'testing')
  app.config.set('session', { driver: 'memory' })

  await app.register(HttpServiceProvider)
  await app.boot()
  app.handleExceptions()

  app.useRoutes(
    new Elysia().get('/work/:name/:delay', async ({ params }) => {
      defer(
        () => {
          ran.push(params.name as string)
        },
        { key: 'refresh' }
      )

      await Bun.sleep(Number(params.delay))

      return params.name
    })
  )

  return { handle: (request) => app.handle(request) }
}

describe('two requests deferring at the same moment', () => {
  test('both get their callback', async () => {
    const ran: string[] = []
    const { handle } = await serve(ran)

    await Promise.all([
      handle(new Request('http://localhost/work/slow/120')),
      handle(new Request('http://localhost/work/fast/10'))
    ])

    // `onAfterResponse` runs after `handle` resolves.
    await Bun.sleep(300)

    expect<string[]>([...ran].sort()).toEqual(['fast', 'slow'])
  })

  /** Within one request the key still deduplicates, which is what it is for. */
  test('while one request deferring twice still runs it once', async () => {
    const ran: string[] = []
    const app = new Application(process.cwd())

    app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
    app.config.set('app.env', 'testing')
    app.config.set('session', { driver: 'memory' })

    await app.register(HttpServiceProvider)
    await app.boot()
    app.handleExceptions()

    app.useRoutes(
      new Elysia().get('/twice', () => {
        defer(() => ran.push('once'), { key: 'same' })
        defer(() => ran.push('twice'), { key: 'same' })

        return 'ok'
      })
    )

    await app.handle(new Request('http://localhost/twice'))
    await Bun.sleep(200)

    expect<string[]>(ran).toEqual(['once'])
  })
})

describe('outside a request', () => {
  /** A console command has no scope, and defers into the process-wide queue. */
  test('defer still works and flushes on demand', async () => {
    const ran: string[] = []

    defer(() => ran.push('cli'))

    expect<number>(deferredCount()).toBeGreaterThan(0)

    await flushDeferred()

    expect<string[]>(ran).toEqual(['cli'])
    expect<number>(deferredCount()).toBe(0)
  })
})
