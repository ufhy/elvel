import { describe, expect, test } from 'bun:test'
import { AuthManager } from '../src/manager.ts'

/**
 * The session is resolved only when the request could be carrying one.
 *
 * `AuthServiceProvider` resolves it in `onRequest`, so every request paid for it —
 * a health check with no cookie at all included. Measured by stacking the
 * providers one at a time: mounting the auth endpoints took an application from
 * **4.4µs to 14.8µs per request**, which is more than the whole framework's
 * request pipeline costs (3.9µs). It is 5.4µs now.
 *
 * The saving is not what these guard. What they guard is that a request which
 * *is* carrying a session still gets one — the failure mode of a cheap check like
 * this is silent, and a guard that only looked at cookies would have made bearer
 * tokens stop authenticating without a single test going red.
 */
function manager(options: { cookieName?: string; onResolve?: () => void } = {}): AuthManager {
  const auth = {
    $context: Promise.resolve({
      authCookies: { sessionToken: { name: options.cookieName ?? 'better-auth.session_token' } }
    }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        options.onResolve?.()

        // Whatever arrives, a session is answered — so a skipped lookup shows up
        // as `null` and cannot be confused with "resolved but nobody signed in".
        return headers.get('cookie') !== null || headers.get('authorization') !== null
          ? { user: { id: '1', email: 'ada@test.local' }, session: { id: 's' } }
          : null
      }
    }
  }

  return new AuthManager(auth as never)
}

const ask = async (
  headers: Record<string, string>,
  options: Parameters<typeof manager>[0] = {}
): Promise<unknown> => {
  const auth = manager(options)
  const request = new Request('http://localhost/health', { headers })

  await auth.remember(request)

  return auth.recall(request)
}

describe('a request that cannot be carrying a session', () => {
  test('is not looked up at all', async () => {
    let asked = 0

    expect<unknown>(await ask({}, { onResolve: () => (asked += 1) })).toBeNull()
    expect<number>(asked).toBe(0)
  })

  /** An unrelated cookie is not a session cookie. */
  test('nor is one carrying somebody else’s cookie', async () => {
    let asked = 0

    expect<unknown>(
      await ask({ cookie: 'elvel_session=abc; theme=dark' }, { onResolve: () => (asked += 1) })
    ).toBeNull()
    expect<number>(asked).toBe(0)
  })
})

describe('a request that could be', () => {
  test('is looked up, and the session arrives', async () => {
    let asked = 0
    const session = await ask(
      { cookie: 'better-auth.session_token=abc' },
      { onResolve: () => (asked += 1) }
    )

    expect<number>(asked).toBe(1)
    expect<unknown>(session).toMatchObject({ user: { email: 'ada@test.local' } })
  })

  test('even when the session cookie is not the first one', async () => {
    expect<unknown>(
      await ask({ cookie: 'theme=dark; better-auth.session_token=abc; other=1' })
    ).toMatchObject({ user: { email: 'ada@test.local' } })
  })

  /**
   * The `bearer` plugin puts the session in a header, and the starter kit's own
   * config enables it. A cookie-only guard would have silenced token auth.
   */
  test('and a bearer token is a session too', async () => {
    let asked = 0

    expect<unknown>(
      await ask({ authorization: 'Bearer abc' }, { onResolve: () => (asked += 1) })
    ).toMatchObject({ user: { email: 'ada@test.local' } })
    expect<number>(asked).toBe(1)
  })

  /** The names come from better-auth, so a renamed cookie is still recognised. */
  test('and a renamed cookie is recognised, not guessed at', async () => {
    const renamed = { cookieName: 'myapp.session_token' }

    expect<unknown>(await ask({ cookie: 'myapp.session_token=abc' }, renamed)).toMatchObject({
      user: { email: 'ada@test.local' }
    })
    // And the better-auth default is no longer special.
    expect<unknown>(await ask({ cookie: 'better-auth.session_token=abc' }, renamed)).toBeNull()
  })
})

describe('when better-auth will not say what its cookies are called', () => {
  /** Slower, never wrong: everything with a cookie is passed through. */
  test('any cookie is passed through rather than dropped', async () => {
    let asked = 0
    const auth = {
      $context: Promise.reject(new Error('no context')),
      api: {
        getSession: async () => {
          asked += 1

          return { user: { id: '1', email: 'ada@test.local' }, session: { id: 's' } }
        }
      }
    }

    const instance = new AuthManager(auth as never)
    const request = new Request('http://localhost/health', { headers: { cookie: 'anything=1' } })

    await instance.remember(request)

    expect<number>(asked).toBe(1)
    expect<unknown>(instance.recall(request)).toMatchObject({ user: { email: 'ada@test.local' } })
  })
})
