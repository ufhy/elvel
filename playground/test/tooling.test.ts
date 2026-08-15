import { describe, expect, test as it } from 'bun:test'
import { test } from '@elysian/testing'
import app from '../bootstrap/app.ts'

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
   * Which driver resolved, not which one it should be.
   *
   * Bun has no image API, so this package shells out to sharp, ImageMagick or
   * macOS `sips` — and asserting on a name would fail on a machine with a
   * different one installed. That a driver resolves at all is the framework's
   * part; which one is the machine's.
   */
  it('resolves a driver on this machine', async () => {
    const response = await test(app).getJson('/check/tooling/image')

    response.assertOk().assertJsonPath('available', true)

    expect(((await response.json()) as { driver: string }).driver).toMatch(/Driver$/)
  })
})
