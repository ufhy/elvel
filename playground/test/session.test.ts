import { describe, expect, test as it } from 'bun:test'
import { test } from '@elyvel/testing'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * The session, flash data and CSRF — across requests, which is the only way.
 *
 * Every one of these is about what the *second* request sees. A single-request
 * test of a session is a test of an object in memory; the bugs are all in the
 * cookie, in the serialisation, or in something written after the response was
 * already built.
 */
describe('carrying state between requests', () => {
  it('a value written in one request is there in the next', async () => {
    const first = await test(app).getJson('/session/token')
    const token = (await first.json()) as { token: string; visits: number }

    const visited = await test(app)
      .withCookiesFrom(first)
      .postJson('/session/visit', { _token: token.token })

    visited.assertOk().assertJsonPath('visits', token.visits + 1)

    const after = await test(app).withCookiesFrom(visited).getJson('/session/token')

    after.assertJsonPath('visits', token.visits + 1)
  })

  /**
   * Without the cookie, it is a different session.
   *
   * The check that proves the value travelled in the cookie rather than in a
   * module-level variable — which would pass the test above and be a data leak
   * between users in production.
   */
  it('and is not there for somebody who did not get the cookie', async () => {
    const first = await test(app).getJson('/session/token')
    const token = (await first.json()) as { token: string }

    await test(app).withCookiesFrom(first).postJson('/session/visit', { _token: token.token })

    const stranger = await test(app).getJson('/session/token')

    stranger.assertJsonPath('visits', 0)
  })
})

describe('CSRF', () => {
  it('a POST with no token is refused', async () => {
    const response = await test(app).postJson('/session/visit', {})

    // 419, not 403: the request was understood and the caller may well be
    // entitled to make it — what is missing is proof that they meant to.
    response.assertStatus(419)
  })

  it('and one carrying the wrong token is refused too', async () => {
    const first = await test(app).getJson('/session/token')

    const response = await test(app)
      .withCookiesFrom(first)
      .postJson('/session/visit', { _token: 'not-the-token' })

    response.assertStatus(419)
  })

  /**
   * The token belongs to the session that issued it.
   *
   * A token accepted with somebody else's cookie would make the whole mechanism
   * decorative: an attacker who can read one page could forge a request for
   * anybody.
   */
  it('and a real token with the wrong session is refused', async () => {
    const mine = await test(app).getJson('/session/token')
    const theirs = await test(app).getJson('/session/token')
    const token = ((await mine.json()) as { token: string }).token

    const response = await test(app)
      .withCookiesFrom(theirs)
      .postJson('/session/visit', { _token: token })

    response.assertStatus(419)
  })

  it('while the right token with the right session goes through', async () => {
    const first = await test(app).getJson('/session/token')
    const token = ((await first.json()) as { token: string }).token

    const response = await test(app)
      .withCookiesFrom(first)
      .postJson('/session/visit', { _token: token })

    response.assertOk()
  })
})

describe('flash data', () => {
  /**
   * Flashed data lives for exactly one request.
   *
   * The second read is the assertion that matters: data that survived would
   * reappear on a page nobody expected it on, which is how a stale "saved!"
   * banner ends up over an unrelated form.
   */
  it('survives one request and no more', async () => {
    const first = await test(app).getJson('/session/token')
    const token = ((await first.json()) as { token: string }).token

    const visited = await test(app)
      .withCookiesFrom(first)
      .postJson('/session/visit', { _token: token })

    const read = await test(app).withCookiesFrom(visited).getJson('/session/status')
    read.assertJsonPath('status', 'Visited!')

    const again = await test(app).withCookiesFrom(read).getJson('/session/status')
    again.assertJsonPath('status', null)
  })
})

describe('the cookie itself', () => {
  it('is http-only and same-site, which is not decorative', async () => {
    const response = await test(app).get('/')
    const cookie = response.headers.getSetCookie().find((one) => one.startsWith('elyvel_session'))

    expect(cookie).toBeDefined()
    // HttpOnly keeps it away from a script that got onto the page; SameSite is
    // what makes CSRF a second line of defence rather than the only one.
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })
})
