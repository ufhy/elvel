import { describe, expect, test } from 'bun:test'
import { CacheServiceProvider } from '@elvel/cache'
import { Application, requestSlot, withoutRequestContext } from '@elvel/core'
import { DatabaseServiceProvider } from '@elvel/database'
import { Elysia } from 'elysia'
import { HttpServiceProvider } from '../src/index.ts'

/**
 * Two requests from one frame keep nothing from each other.
 *
 * `app.handle()` is how the framework's own test helper drives an application,
 * and `enterWith` inside it reaches the **caller's** frame — so a context opened
 * by the first request was still there when the second one opened its own. With
 * the context inheriting everything it found, the second request started with the
 * first one's session, cookie jar, current route and signed-in user.
 *
 * A served request never saw it: each arrives from `Bun.serve` in a frame of its
 * own, verified with three concurrent Elysia requests and interleaved delays. A
 * test making two requests saw it every time, silently, and in the direction that
 * makes a wrong assertion pass.
 *
 * Found by a Telescope-shaped spike whose per-request batch the second request
 * inherited, found already completed, and wrote nothing into.
 */
async function application(): Promise<Application> {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', 'production')
  app.config.set('session', { driver: 'memory', csrf: false })
  app.config.set('cache', { default: 'array', stores: { array: { driver: 'array' } } })
  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })

  await app.register(DatabaseServiceProvider)
  await app.register(CacheServiceProvider)
  await app.register(HttpServiceProvider)
  await app.boot()

  return app
}

describe('two requests handled from one frame', () => {
  test('do not share a slot', async () => {
    const app = await application()
    const slot = requestSlot<string>('per-request')
    const seen: string[] = []

    app.useRoutes(
      new Elysia({ name: 'isolation' }).get('/x', () => {
        seen.push(slot.get() ?? 'nothing')
        slot.set('written by an earlier request')

        return { ok: true }
      })
    )

    await app.handle(new Request('http://localhost/x'))
    await app.handle(new Request('http://localhost/x'))

    expect<string[]>(seen).toEqual(['nothing', 'nothing'])
  })

  /**
   * And a hundred of them, because two can pass by luck.
   *
   * Sequential rather than concurrent on purpose: concurrency was never the
   * broken case — a shared *frame* was, and awaiting each one in turn is exactly
   * the shape a test suite has.
   */
  test('stay isolated across a hundred of them', async () => {
    const app = await application()
    const slot = requestSlot<number>('counter')
    const leaked: number[] = []

    app.useRoutes(
      new Elysia({ name: 'isolation-many' }).get('/n', () => {
        const carried = slot.get()

        if (carried !== undefined) leaked.push(carried)
        slot.set(1)

        return { ok: true }
      })
    )

    for (let n = 0; n < 100; n++) {
      await app.handle(new Request('http://localhost/n'))
    }

    expect<number[]>(leaked).toEqual([])
  })

  /**
   * What a caller outside the request establishes still reaches **every** one.
   *
   * This is the half that makes the fix hard, and the reason marking a context is
   * not enough on its own: `AuthManager.runWith` sets a session and then calls
   * the application, and after the first request the thing surrounding the second
   * is the first — so refusing to inherit a marked context would have dropped the
   * session that was outside both.
   */
  test('still see what was established outside them', async () => {
    const app = await application()
    const acting = requestSlot<string>('acting-as')
    const seen: Array<string | undefined> = []

    app.useRoutes(
      new Elysia({ name: 'isolation-outside' }).get('/who', () => {
        seen.push(acting.get())

        return { ok: true }
      })
    )

    await withoutRequestContext(async () => {
      acting.set('a signed-in user')

      await app.handle(new Request('http://localhost/who'))
      await app.handle(new Request('http://localhost/who'))
    })

    expect<Array<string | undefined>>(seen).toEqual(['a signed-in user', 'a signed-in user'])
  })
})
