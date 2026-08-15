import { describe, expect, test as it } from 'bun:test'
import { test } from '@elysian/testing'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * Pressing the application, with no socket and no server.
 *
 * This is what a feature test looks like in an Elysian application: import the
 * booted app, hand it to `test()`, and assert on what came back. Everything the
 * framework does on a real request happens here too — middleware, the session,
 * validation, the exception handler — because it is the same `handle()` a socket
 * would call.
 *
 * The reason to have these at all, and not only the framework's own tests: the
 * framework's tests build a small application to exercise one package, while
 * this one has every provider registered at once. Ordering bugs between
 * providers only exist in the second shape, and that is where they have been
 * found.
 */
describe('a page', () => {
  it('renders, with a doctype and the layout', async () => {
    ;(await test(app).get('/'))
      .assertOk()
      .assertHeaderContains('content-type', 'text/html')
      .assertSee('<!DOCTYPE html>')
      .assertSee('playground')
  })

  it('a route that does not exist answers 404 rather than 500', async () => {
    ;(await test(app).get('/nothing-is-here')).assertNotFound()
  })

  /**
   * The escaping check, which is worth one test on its own.
   *
   * `safe` on a JSX element is what escapes an interpolated value. A page that
   * forgets it renders whatever was typed into a form as markup, and no status
   * code shows that.
   */
  it('escapes what it prints', async () => {
    const response = await test(app).get('/check/view-helpers')

    response.assertOk().assertDontSee('<script>alert')
  })
})

describe('JSON', () => {
  it('comes back decoded, with the shape asserted rather than the string', async () => {
    const response = await test(app).getJson('/check/articles')

    response.assertOk().assertJsonStructure({ data: [['id', 'title']] })
  })

  it('assertJsonPath reads into the document', async () => {
    ;(await test(app).getJson('/check/articles')).assertJsonPath('data.0.id', 1)
  })

  /**
   * The one that catches a schema drifting.
   *
   * `assertJsonFluent` with `etc()` left off is exact: a field added to the
   * response without being added here fails, which is the point — an API that
   * grows fields silently is an API nobody can rely on.
   */
  it('assertJsonFluent can be exact about the whole document', async () => {
    const response = await test(app).getJson('/check/articles/1')

    response.assertOk().assertJsonFluent((json) => {
      json.has('data', undefined, (article) => {
        article.hasAll('id', 'title', 'slug', 'featured', 'meta', 'excerpt', 'self')
      })
    })
  })
})

describe('validation', () => {
  it('a bad body is 422 with the failing field named', async () => {
    const response = await test(app).postJson('/check/articles', { title: '' })

    response.assertUnprocessable().assertInvalid('title')
  })

  it('and a good one is accepted', async () => {
    // `slug` carries `Rule.unique`, so it is minted fresh: a fixed value passes
    // once and then fails for ever, which is a test that lies the second time.
    const slug = `written-by-a-test-${Date.now()}`

    const response = await test(app).postJson('/check/articles', {
      title: 'Written by a test',
      slug,
      body: 'Long enough to be a body, comfortably past whatever minimum it has.',
      // `status` is required and `published_at` is required *if* it is published,
      // so a draft is the shortest valid article there is.
      status: 'draft'
    })

    response.assertSuccessful().assertValid()
  })
})

describe('headers and cookies', () => {
  it('a header sent is a header seen', async () => {
    const response = await test(app)
      .withHeader('accept', 'application/json')
      .get('/check/middleware/api')

    // A JSON caller gets 401 rather than a redirect — the same middleware, told
    // apart by this header alone.
    response.assertUnauthorized().assertHeaderMissing('location')
  })

  it('a cookie queued by the application comes back on the response', async () => {
    const response = await test(app).get('/cookies/set?value=dark')

    response.assertOk().assertCookie('preference')
  })

  /**
   * Sent back rather than made up.
   *
   * Cookies are encrypted, so a handwritten `withCookie('preference', 'dark')`
   * would arrive as something the framework refuses to decrypt — and the test
   * would be asserting that a forged cookie is ignored, which is a different
   * check entirely. `withCookiesFrom` carries the real one across.
   */
  it('and comes back decrypted on the next request', async () => {
    const set = await test(app).get('/cookies/set?value=dark')
    const read = await test(app).withCookiesFrom(set).getJson('/cookies/read')

    read.assertOk().assertJsonPath('preference', 'dark')
  })
})

describe('the exception handler', () => {
  /**
   * A thrown `HttpException` carries its own status.
   *
   * The check is that it reaches the client as that status rather than as a 500:
   * an exception type nobody mapped is the most common way a 404 becomes an
   * incident.
   */
  it('turns a framework exception into its own status', async () => {
    ;(await test(app).getJson('/check/articles/9999')).assertNotFound()
  })

  it('and reports the exception name when debug is on', async () => {
    const response = await test(app).getJson('/check/articles/9999')

    expect(await response.json()).toHaveProperty('exception')
  })
})
