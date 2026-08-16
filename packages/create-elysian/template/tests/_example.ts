import { describe, expect, test } from 'bun:test'
import { test as press } from '@elysian/testing'
import app from '../bootstrap/app.ts'

/**
 * A feature test: the whole application, without a socket.
 *
 * `press(app)` runs a request through the same `handle()` a server would —
 * middleware, the session, validation, the exception handler and all — so what
 * passes here is what a browser would have got. There is no server to start and
 * no port to pick.
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

describe('arithmetic, to prove the runner works', () => {
  test('adds up', () => {
    // A unit test needs no application at all — most of yours will look like
    // this, and they are the fast ones.
    expect(1 + 1).toBe(2)
  })
})
