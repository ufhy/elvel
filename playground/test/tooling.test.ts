import { describe, expect, test as it } from 'bun:test'
import { test } from '@elyvel/testing'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * The four packages this application did not have.
 *
 * `hashing`, `concurrency`, `process` and `image` ship with the framework and
 * the scaffold registers all four — this playground registered none, so nothing
 * ever proved they boot alongside the rest. The first test that asked for
 * `hash()` got "not bound in the container", which is the failure a user would
 * have hit on their own machine.
 *
 * These are thin on purpose. Each package has its own tests; what those cannot
 * show is that the provider registers and the binding is there once every other
 * provider is in the room too.
 */
describe('hashing', () => {
  it('hashes, verifies, refuses and salts', async () => {
    const response = await test(app).getJson('/check/tooling/hash')

    response
      .assertOk()
      .assertJsonPath('verified', true)
      // The negative matters as much: a `check` that answered true for anything
      // would pass every sign-in ever attempted.
      .assertJsonPath('refused', false)
      .assertJsonPath('salted', true)
      .assertJsonPath('info.algorithm', 'bcrypt')
  })
})

describe('concurrency', () => {
  /**
   * Two tasks, run beside each other, each in its own worker.
   *
   * They are module references rather than closures because a function cannot
   * cross into a worker — its captured scope does not travel. That is the reason
   * for the `{ module, export, args }` shape, and it is worth one test that
   * actually starts a worker rather than a mock that pretends to.
   */
  it('runs tasks in workers and keeps their order', async () => {
    const response = await test(app).getJson('/check/tooling/concurrency')

    response.assertOk().assertJsonPath('results.0', 5).assertJsonPath('results.1', 15)
  })
})

describe('process', () => {
  it('runs a child and captures its output', async () => {
    const response = await test(app).getJson('/check/tooling/process')

    response
      .assertOk()
      .assertJsonPath('ok', true)
      .assertJsonPath('code', 0)
      .assertJsonPath('output', 'from a child process')
  })
})

describe('image', () => {
  /**
   * Reading the header always works; transforming depends on the machine.
   *
   * `probe()` is pure TypeScript, so it is asserted outright. A driver is not:
   * sharp, ImageMagick and `sips` are three things a machine may or may not
   * have, and this Linux box has none of them. An earlier version of this test
   * demanded one and failed here — asserting a fact about the machine as though
   * it were a fact about the framework.
   */
  it('reads an image header, and says whether a driver is available', async () => {
    const response = await test(app).getJson('/check/tooling/image')

    response
      .assertOk()
      // A one-pixel PNG, read out of its bytes with nothing installed.
      .assertJsonPath('probed.format', 'png')
      .assertJsonPath('probed.width', 1)
      .assertJsonPath('probed.height', 1)

    const body = (await response.json()) as {
      available: boolean
      driver: string | null
      reason: string | null
    }

    // Whichever way it went, the answer has to be a real one rather than silence.
    if (body.available) expect(body.driver).toMatch(/Driver$/)
    else expect(body.reason ?? '').not.toBe('')
  })
})
