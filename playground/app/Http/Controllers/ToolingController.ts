import { concurrency } from '@elysian/concurrency'
import { controller } from '@elysian/core'
import { hash } from '@elysian/hashing'
import { image } from '@elysian/image'
import { process } from '@elysian/process'

/**
 * The four packages the playground never booted.
 *
 * `hashing`, `concurrency`, `process` and `image` ship with the framework and
 * are registered by the scaffold's `config/app.ts`, but this application had
 * none of them — so nothing here ever proved they boot together with the rest,
 * and `hash()` threw "not bound in the container" the first time a test asked
 * for it.
 *
 * Each route is deliberately small. The packages have their own tests; what
 * these are for is the thing those cannot show — that the provider registers,
 * the config resolves, and the binding is there in a real application.
 */
export default controller('tooling', '/check/tooling')
  /** A password hashed and verified, which is the whole of the package's job. */
  .get('/hash', async () => {
    const hashed = await hash().make('longenough1')

    return {
      // What the hash says about itself: the algorithm and its cost, read back
      // out of the stored string rather than out of the config.
      info: hash().info(hashed),
      verified: await hash().check('longenough1', hashed),
      // The negative matters as much: a `check` that answered true for anything
      // would pass every sign-in.
      refused: await hash().check('wrong-password', hashed),
      // Two hashes of one password differ, because of the salt.
      salted: hashed !== (await hash().make('longenough1'))
    }
  })

  /**
   * Work run beside itself.
   *
   * The tasks are module references rather than closures on purpose: a function
   * cannot cross into a worker, because its captured scope does not travel. That
   * limit is why the API takes `{ module, export, args }`.
   */
  .get('/concurrency', async () => {
    const results = (await concurrency().run([
      { module: './app/Support/arithmetic.ts', export: 'add', args: [2, 3] },
      { module: './app/Support/arithmetic.ts', export: 'add', args: [10, 5] }
    ])) as number[]

    return { results }
  })

  /** A child process, its output captured rather than inherited. */
  .get('/process', async () => {
    const result = await process().run(['echo', 'from a child process'])

    return {
      ok: result.successful(),
      code: result.exitCode,
      output: result.output.trim()
    }
  })

  /**
   * Whether an image driver is actually available.
   *
   * Bun has no image API, so this package shells out to `sharp`, ImageMagick or
   * macOS `sips`, and which of them exists depends on the machine. The honest
   * answer is which driver resolved — a route that transformed an image would
   * fail on a box with none of the three, and that is not a framework fault.
   */
  .get('/image', () => {
    // Resolving the driver is the check. Which one it is depends on the machine,
    // and asserting on a name would fail on a box with a different tool.
    const driver = image().driver()

    return { available: driver !== undefined, driver: driver.constructor.name }
  })
