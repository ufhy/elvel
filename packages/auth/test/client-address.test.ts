import { afterEach, describe, expect, test } from 'bun:test'
import { CacheServiceProvider } from '@elvel/cache'
import { Application } from '@elvel/core'
import { DatabaseServiceProvider } from '@elvel/database'
import { HttpServiceProvider } from '@elvel/http'
import { AuthServiceProvider } from '../src/index.ts'

/**
 * The rate limit counts the caller, not a header the caller chose.
 *
 * better-auth resolves the client from headers only — it never sees the socket —
 * and with no `trustedProxies` its `getIPFromHeader` trusts a single-value
 * `x-forwarded-for` outright. Measured on a scaffolded `api` kit in production
 * with nothing in front of it: thirty failed sign-ins against one account, a
 * different `x-forwarded-for` on each, **none refused**; thirty with no header,
 * twenty-seven refused. One header turned the limit off.
 *
 * These tests **must** run against a listening server. `app.handle()` has no
 * socket, so `server.requestIP` is absent, the framework injects nothing, and
 * every one of them would pass on the broken code for the wrong reason.
 */

const servers: Application[] = []

afterEach(async () => {
  for (const app of servers.splice(0)) {
    await (app as unknown as { router: { stop(closeActive?: boolean): unknown } }).router.stop(true)
  }
})

let next = 39_100

/**
 * A distinct address block per server, which the tests **need**.
 *
 * better-auth keys its buckets `ip|path` in storage that lives for the process,
 * so every server in this file shares them. Two tests rotating through
 * `203.0.113.1…10` are not two tests: the second one inherits the first one's
 * exhausted buckets and asserts whatever that leaves behind. Found by running
 * these against the unfixed provider and getting a failure in a test that should
 * have passed there.
 */
function block(port: number): number {
  return port - 39_100
}

async function serve(config: Record<string, unknown> = {}): Promise<number> {
  const port = next++
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: `http://localhost:${port}`, name: 'Test' })
  app.config.set('app.env', 'production')
  app.config.set('session', { driver: 'memory', csrf: false })
  app.config.set('cache', { default: 'array', stores: { array: { driver: 'array' } } })
  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })
  app.config.set('http', { trustedProxies: config.trustedProxies ?? [] })
  app.config.set('auth', {
    secret: 'b'.repeat(40),
    baseURL: `http://localhost:${port}`,
    emailAndPassword: { enabled: true },
    ...(config.auth as Record<string, unknown> | undefined)
  })

  await app.register(DatabaseServiceProvider)
  await app.register(CacheServiceProvider)
  await app.register(HttpServiceProvider)
  await app.register(AuthServiceProvider)
  await app.boot()
  await app.listen(port, '127.0.0.1')

  servers.push(app)

  return port
}

/**
 * Failed sign-ins, optionally with a header that changes every time.
 *
 * The tables are not created, so the handler answers 500 — which does not
 * matter: the limiter runs before it, and `429` is the only status under test.
 * `rate-limit-env.test.ts` leans on the same thing.
 */
async function attempts(
  port: number,
  count: number,
  header?: (n: number) => Record<string, string>
): Promise<number[]> {
  const statuses: number[] = []

  for (let n = 0; n < count; n++) {
    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://localhost:${port}`,
        ...header?.(n)
      },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrongwrongwrong' })
    })
    statuses.push(answer.status)
  }

  return statuses
}

const rotatingForwardedFor = (port: number) => (n: number) => ({
  'x-forwarded-for': `203.0.${block(port)}.${n + 1}`
})

describe('the rate limit', () => {
  test('still refuses a caller who sends no headers at all', async () => {
    const port = await serve()

    expect(await attempts(port, 8)).toContain(429)
  })

  /**
   * The bug this closes.
   *
   * With nothing trusted in front of the application, a forwarded header is
   * whatever the caller typed, and honouring it hands out a fresh bucket per
   * request.
   */
  test('is not bypassed by rotating x-forwarded-for', async () => {
    const port = await serve()

    expect(await attempts(port, 10, rotatingForwardedFor(port))).toContain(429)
  })

  /**
   * And not by the framework's own header either.
   *
   * The handler deletes any inbound copy before writing its own; without that
   * deletion this would be the same bypass with a different header name.
   */
  test('is not bypassed by rotating the header the framework injects', async () => {
    const port = await serve()
    const statuses = await attempts(port, 10, (n) => ({
      'x-elvel-client-ip': `198.51.${block(port)}.${n + 1}`
    }))

    expect(statuses).toContain(429)
  })

  test('is not bypassed by sending both', async () => {
    const port = await serve()
    const statuses = await attempts(port, 10, (n) => ({
      'x-forwarded-for': `203.0.${block(port)}.${n + 1}`,
      'x-elvel-client-ip': `198.51.${block(port)}.${n + 1}`
    }))

    expect(statuses).toContain(429)
  })
})

describe('a trusted proxy', () => {
  /**
   * The other direction, and why this is not simply "ignore forwarded headers".
   *
   * Behind a proxy the application named, the forwarded address **is** the
   * client and each one deserves its own bucket. `127.0.0.1` is the socket these
   * requests actually arrive on, so naming it is what makes the header
   * trustworthy here.
   */
  test('gets a bucket per forwarded address', async () => {
    const port = await serve({ trustedProxies: ['127.0.0.1'] })
    const statuses = await attempts(port, 10, rotatingForwardedFor(port))

    expect(statuses).not.toContain(429)
  })

  test('does not make an untrusted socket trustworthy', async () => {
    const port = await serve({ trustedProxies: ['10.1.2.3'] })
    const statuses = await attempts(port, 10, rotatingForwardedFor(port))

    expect(statuses).toContain(429)
  })
})

describe('an application that names its own ipAddressHeaders', () => {
  /**
   * Keeps them, and keeps the consequences.
   *
   * Nothing is injected, so better-auth reads what the caller sent — which is
   * the decision the application made by writing the option, and the framework
   * does not overrule it.
   */
  test('is left alone', async () => {
    const port = await serve({
      auth: { advanced: { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } } }
    })
    const statuses = await attempts(port, 10, rotatingForwardedFor(port))

    expect(statuses).not.toContain(429)
  })
})
