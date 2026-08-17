import { describe, expect, test as it } from 'bun:test'
import { can, cannot, gate } from '@elvel/auth'
import { test } from '@elvel/testing'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * Authentication and authorization, without signing anybody in for real.
 *
 * `actingAs` puts a user in scope for the duration of a callback and takes it
 * away afterwards, so a test never has to post credentials, hold a cookie, or
 * leave a session behind for the next file to trip over.
 */
const admin = { id: '1', email: 'admin@example.com', name: 'Admin' }
const ada = { id: '2', email: 'ada@example.com', name: 'Ada' }

describe('the guard', () => {
  it('a guest is redirected from a page and refused JSON', async () => {
    const page = await test(app).get('/check/middleware/private')
    const json = await test(app).acceptJson().get('/check/middleware/api')

    page.assertRedirect('/sign-in')
    // The same middleware, told apart by the `accept` header alone: a client
    // that followed the redirect would treat a sign-in page as its answer.
    json.assertUnauthorized().assertHeaderMissing('location')
  })

  it('and a signed-in user is let through', async () => {
    await test(app).actingAs(ada, async (request) => {
      ;(await request.get('/check/middleware/private')).assertOk()
    })
  })

  /**
   * The impersonation must not outlive the callback.
   *
   * A test that leaked a user would make every later test pass as that user —
   * including the ones asserting that a guest is refused.
   */
  it('and the user is gone again afterwards', async () => {
    await test(app).actingAs(ada, async (request) => {
      ;(await request.get('/check/middleware/private')).assertOk()
    })

    ;(await test(app).get('/check/middleware/private')).assertRedirect('/sign-in')
  })
})

describe('the Gate', () => {
  it('an ability that allows guests answers without a user', async () => {
    expect(await can('view-status-page')).toBe(true)
  })

  it('and one that needs a user refuses a guest', async () => {
    expect(await can('access-admin')).toBe(false)
    expect(await cannot('access-admin')).toBe(true)
  })

  it('the same ability answers differently per user', async () => {
    await test(app).actingAs(admin, async () => {
      expect(await can('access-admin')).toBe(true)
    })

    await test(app).actingAs(ada, async () => {
      expect(await can('access-admin')).toBe(false)
    })
  })

  /**
   * A denied ability is a 403 at the route, not a 500.
   *
   * `can:` middleware throws `AuthorizationError`, and the check is that the
   * handler maps it — an unmapped exception type is how an authorization refusal
   * becomes a page saying the server broke.
   */
  it('the can middleware answers 403', async () => {
    ;(await test(app).get('/check/middleware/gated')).assertForbidden()
  })

  it('and an ability that was never defined denies rather than allowing', async () => {
    // Failing open here would mean a typo in an ability name silently grants it.
    expect(await can('an-ability-nobody-defined')).toBe(false)
  })
})

describe('defining abilities in a test', () => {
  it('a definition made here is visible to the Gate', async () => {
    gate().define('test-only-ability', (user) => user?.email === ada.email)

    await test(app).actingAs(ada, async () => {
      expect(await can('test-only-ability')).toBe(true)
    })

    await test(app).actingAs(admin, async () => {
      expect(await can('test-only-ability')).toBe(false)
    })
  })
})
