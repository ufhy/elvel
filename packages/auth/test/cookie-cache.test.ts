import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CacheServiceProvider } from '@elvel/cache'
import { Application } from '@elvel/core'
import { DatabaseServiceProvider, SchemaBuilder } from '@elvel/database'
import { HttpServiceProvider } from '@elvel/http'
import { migrationFor } from '../src/adapter.ts'
import { AuthServiceProvider } from '../src/index.ts'
import { SessionRevocations } from '../src/revocation.ts'

/**
 * `session.cookieCache` is revocable, for whoever turns it on.
 *
 * The cache puts the session and the user row in a cookie so most requests need
 * no store lookup — 6,664 req/s to 10,241 on the cookie path, measured. What it
 * costs is that nothing reads the store any more, so a session that has been
 * signed out keeps working until the cookie expires: five minutes at
 * better-auth's own `maxAge`, in which "log out everywhere" has not happened.
 *
 * These tests are written through `app.handle()` rather than by inspecting the
 * options, because what matters is what a request carrying a stale cookie is
 * answered — and because the control below only has teeth end to end: with a
 * constant `version`, which is better-auth configured plainly, the same stale
 * cookie is still accepted.
 */

const BASE = 'http://localhost'

async function boot(cookieCache: Record<string, unknown>): Promise<Application> {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: BASE, name: 'Test' })
  app.config.set('app.env', 'testing')
  app.config.set('session', { driver: 'memory', csrf: false })
  app.config.set('cache', { default: 'array', stores: { array: { driver: 'array' } } })
  app.config.set('database', {
    default: 'sqlite',
    connections: { sqlite: { driver: 'sqlite', database: ':memory:' } }
  })
  app.config.set('auth', {
    secret: 'b'.repeat(40),
    baseURL: BASE,
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    session: { cookieCache }
  })

  await app.register(DatabaseServiceProvider)
  await app.register(CacheServiceProvider)
  await app.register(HttpServiceProvider)
  await app.register(AuthServiceProvider)
  await app.boot()

  await tables(app)

  return app
}

/**
 * The auth tables, from the generator rather than written out here.
 *
 * Same reasoning as the adapter suite: a hand-written fixture can only agree
 * with the better-auth version it was written against, and 1.7 adding
 * `account.issuer` broke exactly that.
 */
async function tables(app: Application): Promise<void> {
  // The manager holds the better-auth instance privately; its `$context` is
  // where the table shapes live, and `auth:schema` reads the same thing.
  const { auth } = app.make('auth') as unknown as {
    auth: { $context: Promise<{ tables: never }> }
  }
  const schema = await auth.$context.then((context) => context.tables)

  const connection = await app.make('db').connection()
  const directory = await mkdtemp(join(import.meta.dir, '.cookie-cache-'))
  const file = join(directory, 'migration.ts')

  await writeFile(file, migrationFor(schema, 'sqlite'))

  const Generated = (
    (await import(pathToFileURL(file).href)) as {
      default: new () => { up(context: unknown): Promise<void> }
    }
  ).default

  await new Generated().up({ schema: new SchemaBuilder(connection), connection })
  await rm(directory, { recursive: true, force: true })
}

/** Sign up, sign in, and keep the cookies the way a browser would. */
async function signIn(app: Application, email: string): Promise<string> {
  const body = (extra: Record<string, string>) =>
    JSON.stringify({ email, password: 'password1234', ...extra })
  const headers = { 'content-type': 'application/json', origin: BASE }

  await app.handle(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers,
      body: body({ name: 'Cookie Person' })
    })
  )

  const answer = await app.handle(
    new Request(`${BASE}/api/auth/sign-in/email`, { method: 'POST', headers, body: body({}) })
  )

  expect(answer.status).toBe(200)

  return answer.headers
    .getAll('set-cookie')
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

/** Whether better-auth still recognises the session this cookie claims. */
async function recognised(app: Application, cookie: string): Promise<boolean> {
  const answer = await app.handle(
    new Request(`${BASE}/api/auth/get-session`, { headers: { cookie, origin: BASE } })
  )
  const body = (await answer.json()) as { session?: unknown } | null

  return body?.session !== undefined && body?.session !== null
}

async function signOut(app: Application, cookie: string): Promise<void> {
  const answer = await app.handle(
    new Request(`${BASE}/api/auth/sign-out`, {
      method: 'POST',
      headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: '{}'
    })
  )

  expect(answer.status).toBe(200)
}

describe('a cached session cookie', () => {
  test('is cached at all — the cookie carries the session data', async () => {
    const app = await boot({ enabled: true, maxAge: 300 })
    const cookie = await signIn(app, 'cached@example.test')

    expect(cookie).toContain('session_data')
    expect(await recognised(app, cookie)).toBe(true)
  })

  /**
   * The bug, and the fix, in one test.
   *
   * Signing out deletes the session row. A client that keeps the old cookie —
   * a stolen one, a stale tab — is asking better-auth to trust its cached copy,
   * and with the cache configured plainly it does, for the whole `maxAge`.
   */
  test('stops being recognised the moment the session is signed out', async () => {
    const app = await boot({ enabled: true, maxAge: 300 })
    const cookie = await signIn(app, 'revoked@example.test')

    expect(await recognised(app, cookie)).toBe(true)

    await signOut(app, cookie)

    expect(await recognised(app, cookie)).toBe(false)
  })

  /**
   * The control, without which the test above proves nothing.
   *
   * A constant `version` is better-auth as it ships: the framework installs
   * nothing over the top, and the same stale cookie is still accepted.
   */
  test('would still be recognised with a constant version, which is the bug', async () => {
    const app = await boot({ enabled: true, maxAge: 300, version: 'fixed' })
    const cookie = await signIn(app, 'constant@example.test')

    await signOut(app, cookie)

    expect(await recognised(app, cookie)).toBe(true)
  })

  test('is not cached in a cookie at all when the cache is off', async () => {
    const app = await boot({})
    const cookie = await signIn(app, 'uncached@example.test')

    expect(cookie).not.toContain('session_data')

    await signOut(app, cookie)

    expect(await recognised(app, cookie)).toBe(false)
  })

  /**
   * The default strategy is `jwe`, not better-auth's `compact`.
   *
   * `compact` is base64 JSON: signed, so it cannot be forged, but readable by
   * anyone holding the cookie — the user's own row included. Caching the session
   * and publishing it to the client are different decisions, and only the first
   * one was asked for.
   */
  test('does not put the user row somewhere the client can read it', async () => {
    const app = await boot({ enabled: true, maxAge: 300 })
    const cookie = await signIn(app, 'opaque@example.test')
    const value = decodeURIComponent(
      cookie
        .split('; ')
        .find((part) => part.startsWith('better-auth.session_data='))
        ?.split('=')
        .slice(1)
        .join('=') ?? ''
    )

    expect(value).not.toBe('')
    expect(value).not.toContain('opaque@example.test')

    let decoded = ''
    try {
      decoded = Buffer.from(value.split('.')[0] ?? '', 'base64').toString('utf8')
    } catch {
      decoded = ''
    }

    expect(decoded).not.toContain('opaque@example.test')
  })

  test('keeps a strategy the application chose for itself', async () => {
    const app = await boot({ enabled: true, maxAge: 300, strategy: 'compact' })
    const cookie = await signIn(app, 'chosen@example.test')

    expect(await recognised(app, cookie)).toBe(true)
  })
})

describe('SessionRevocations', () => {
  type Store = {
    get(key: string): Promise<unknown>
    put(key: string, value: unknown): Promise<boolean>
  }

  const backed = (store: Store) => ({ store: () => store }) as never

  test("answers better-auth's own default for a user never revoked", async () => {
    const map = new Map<string, unknown>()
    const revocations = new SessionRevocations(
      () => backed({ get: async (key) => map.get(key) ?? null, put: async () => true }),
      360
    )

    expect(await revocations.epoch('someone')).toBe('1')
  })

  test('answers something else once that user is revoked', async () => {
    const map = new Map<string, unknown>()
    const revocations = new SessionRevocations(
      () =>
        backed({
          get: async (key) => map.get(key) ?? null,
          put: async (key, value) => {
            map.set(key, value)
            return true
          }
        }),
      360
    )

    const before = await revocations.epoch('someone')
    await revocations.revoke('someone')

    expect(await revocations.epoch('someone')).not.toBe(before)
  })

  test('revoking one user leaves another alone', async () => {
    const map = new Map<string, unknown>()
    const revocations = new SessionRevocations(
      () =>
        backed({
          get: async (key) => map.get(key) ?? null,
          put: async (key, value) => {
            map.set(key, value)
            return true
          }
        }),
      360
    )

    await revocations.revoke('one')

    expect(await revocations.epoch('two')).toBe('1')
  })

  /**
   * Fails closed, twice over.
   *
   * With no cache to read, the honest answer is not "nothing was revoked" — it
   * is "this cannot be established", and a cached cookie must not be trusted on
   * an unanswerable question. Two calls disagreeing is the point: the same
   * function fills in the version when the cookie is written, so a constant
   * would be written and then matched.
   */
  test('cannot be matched when there is no cache at all', async () => {
    const revocations = new SessionRevocations(() => undefined, 360)

    expect(await revocations.epoch('someone')).not.toBe('1')
    expect(await revocations.epoch('someone')).not.toBe(await revocations.epoch('someone'))
  })

  test('cannot be matched when the cache throws', async () => {
    const revocations = new SessionRevocations(
      () =>
        backed({
          get: async () => {
            throw new Error('redis is down')
          },
          put: async () => true
        }),
      360
    )

    expect(await revocations.epoch('someone')).not.toBe('1')
  })

  test('does not throw when the cache cannot record a revocation', async () => {
    const revocations = new SessionRevocations(
      () =>
        backed({
          get: async () => null,
          put: async () => {
            throw new Error('redis is down')
          }
        }),
      360
    )

    expect(await revocations.revoke('someone')).toBeUndefined()
  })
})
