import { describe, test } from 'bun:test'
import { test as press } from '@elyvel/testing'
import app from '../../bootstrap/app.ts'

/**
 * A feature test: the whole application, without a socket.
 *
 * `press(app)` runs a request through the same `handle()` a server would —
 * middleware, the session, validation, the exception handler and all — so what
 * passes here is what a browser would have got. There is no server to start and
 * no port to pick.
 *
 * `tests/Feature` for tests that boot the application, `tests/Unit` for the ones
 * that do not — Laravel's split, and worth keeping: the two have very different
 * costs, and being able to run the fast ones alone is the difference between a
 * suite you run on every save and one you run before pushing.
 *
 * Delete this file once you have tests of your own; it is here to show the
 * shape and to give `bun test` something to find on the first day.
 */
describe('the landing page', () => {
  test('renders', async () => {
    const response = await press(app).get('/')

    response
      .assertOk()
      .assertHeaderContains('content-type', 'text/html')
      .assertSee('<!DOCTYPE html>')
  })

  test('a route that does not exist answers 404, not 500', async () => {
    ;(await press(app).get('/nothing-is-here')).assertNotFound()
  })
})
