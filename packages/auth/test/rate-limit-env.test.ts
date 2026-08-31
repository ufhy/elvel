import { describe, expect, test } from 'bun:test'
import { CacheServiceProvider } from '@elvel/cache'
import { Application } from '@elvel/core'
import { DatabaseServiceProvider } from '@elvel/database'
import { HttpServiceProvider } from '@elvel/http'
import { AuthServiceProvider } from '../src/index.ts'

/**
 * better-auth's rate limit follows *this* application's environment.
 *
 * better-auth decides for itself from `NODE_ENV === 'production'`, and an Elvel
 * application says what environment it is in through `APP_ENV`. So a deployment
 * that sets `APP_ENV=production` and says nothing about `NODE_ENV` — the way this
 * framework documents running one — left the endpoints better-auth mounts with
 * **no rate limit at all**, while `throttle:6,1` guarded `/api/login`, a route the
 * auth client never calls.
 *
 * Found by measuring a scaffolded application rather than by reading: twenty
 * failed sign-ins in a row against `/api/auth/sign-in/email` answered `401` twenty
 * times. Asserted here the same way — by asking, not by inspecting the options,
 * because what matters is what the endpoint does.
 */
async function statuses(env: string, config: Record<string, unknown> = {}): Promise<number[]> {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', env)
  app.config.set('session', { driver: 'memory', csrf: false })
  app.config.set('cache', { default: 'array', stores: { array: { driver: 'array' } } })
  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })
  app.config.set('auth', {
    secret: 'b'.repeat(40),
    baseURL: 'http://localhost',
    // Without this better-auth answers "not enabled" rather than "wrong password",
    // and the statuses below say nothing about rate limiting.
    emailAndPassword: { enabled: true },
    ...config
  })

  await app.register(DatabaseServiceProvider)
  await app.register(CacheServiceProvider)
  await app.register(HttpServiceProvider)
  await app.register(AuthServiceProvider)
  await app.boot()
  app.handleExceptions()

  const seen: number[] = []

  /**
   * Eight failed sign-ins. better-auth's own rule for this path is three in ten
   * seconds, so a limit that is on shows itself well before the eighth.
   *
   * The limiter runs before the handler, so what the sign-in would have failed
   * with is irrelevant — this application has no auth tables and the attempt would
   * end in a 500. That is deliberate: it keeps the setup to the one thing under
   * test, and a 429 arriving before any database work is the strongest form of the
   * assertion.
   */
  for (let attempt = 0; attempt < 8; attempt++) {
    const answer = await app.handle(
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@test.local', password: 'wrong-password' })
      })
    )

    await answer.text()
    seen.push(answer.status)
  }

  return seen
}

describe('the endpoints better-auth mounts', () => {
  test('are rate limited in production, whatever NODE_ENV says', async () => {
    const seen = await statuses('production')

    expect<boolean>(seen.includes(429)).toBe(true)
  })

  test('and are not outside it, so development is not throttled', async () => {
    const seen = await statuses('local')

    expect<boolean>(seen.includes(429)).toBe(false)

    /**
     * Every answer is the same, whatever it is: the point is that none of them is
     * a refusal to try. It is a 500 here rather than a 401, because this
     * application has no auth tables — the migration is a separate thing and the
     * limiter never reaches the database anyway, which is exactly why the
     * underlying status does not matter to what is being asserted.
     */
    expect<number>(new Set(seen).size).toBe(1)
  })

  /** An application that decided for itself wins, including turning it off. */
  test('unless the application said otherwise', async () => {
    const off = await statuses('production', { rateLimit: { enabled: false } })

    expect<boolean>(off.includes(429)).toBe(false)

    const on = await statuses('local', { rateLimit: { enabled: true } })

    expect<boolean>(on.includes(429)).toBe(true)
  })

  /** Its other settings are carried through rather than replaced by the default. */
  test('and a window it chose is kept', async () => {
    const seen = await statuses('production', { rateLimit: { window: 60, max: 2 } })

    expect<boolean>(seen.includes(429)).toBe(true)
  })
})
