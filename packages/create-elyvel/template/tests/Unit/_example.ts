import { describe, expect, test } from 'bun:test'

/**
 * A unit test: no application, no database, no request.
 *
 * Most of a suite looks like this, and these are the ones that stay fast enough
 * to run on every save. Anything that needs the application booted belongs in
 * `tests/Feature` beside the example there.
 */
describe('arithmetic, to prove the runner works', () => {
  test('adds up', () => {
    expect(1 + 1).toBe(2)
  })
})
