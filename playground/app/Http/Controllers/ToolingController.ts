import { concurrency } from '@elysian/concurrency'
import { controller } from '@elysian/core'
import { hash } from '@elysian/hashing'
import { image, probe } from '@elysian/image'
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
   * The two halves of the image package, which fail differently.
   *
   * `probe()` reads format and dimensions out of the bytes in pure TypeScript,
   * so it works everywhere and is what most applications actually want — a file
   * extension and a client's `content-type` are claims, the header is the file.
   *
   * Transforming needs a backend that is looked for rather than assumed: sharp
   * if the application installed it, ImageMagick if the machine has it, `sips`
   * on macOS. A machine with none of the three is a normal machine — this Linux
   * box is one — so that is reported rather than raised. Asking the route to
   * throw would make "no image tool installed" indistinguishable from a bug.
   */
  .get('/image', () => {
    // A one-pixel PNG, by its bytes: enough for the header reader to work on.
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      ),
      (character) => character.charCodeAt(0)
    )

    let driver: string | null = null
    let reason: string | null = null

    try {
      driver = image().driver().constructor.name
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }

    return { probed: probe(png), available: driver !== null, driver, reason }
  })
