import { afterAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * What a landing page weighs, asserted rather than remembered.
 *
 * It was 1165 modules and 3.72 MB: every scaffolded application registered all
 * twenty-two providers, so it installed and bundled a database, a mailer, a
 * queue and better-auth whether or not it had a use for any of them. Three
 * changes brought it to 557 and 1.47 MB — per-kit providers, per-kit
 * dependencies, per-kit config.
 *
 * None of that would break loudly if it came undone. Adding a provider to
 * `bootstrap/providers.ts` is one line, it makes the application work, and the
 * cost shows up nowhere: no test fails, no page slows, nothing is logged. The
 * number simply goes back up. So it is written down here.
 *
 * The ceilings have room in them — this is a regression test, not a budget — but
 * not enough room to hide a package. The named absences are the sharper half: a
 * `kysely` in the graph of an application with no database says what happened in
 * a way a byte count never will.
 */

const root = resolve(import.meta.dir, '..', '..', '..')

/**
 * Scaffolded inside the checkout on purpose.
 *
 * A workspace member resolves `@elysian/*` through the root's `node_modules`, so
 * it can be built without an install of its own. In a temp directory nothing
 * resolves and there is nothing to measure.
 */
const target = join(root, '.bundle-check')

/**
 * Scaffolding and building take about seven seconds together, and the default
 * five would kill the child mid-build — which surfaces as `exitCode: null` and
 * an empty stderr, a failure that says nothing about itself.
 */
const PATIENCE = 120_000

afterAll(async () => {
  await rm(target, { recursive: true, force: true })
})

describe('what a landing page carries', () => {
  const built = (async () => {
    await rm(target, { recursive: true, force: true })

    const scaffolded = Bun.spawnSync({
      cmd: [
        'bun',
        resolve(import.meta.dir, '..', 'src', 'index.ts'),
        target,
        '--kit=none',
        '--no-install',
        '--force'
      ],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    if (scaffolded.exitCode !== 0) {
      throw new Error(`scaffold failed: ${new TextDecoder().decode(scaffolded.stderr)}`)
    }

    /**
     * The CLI rather than `Bun.build`, which resolves differently.
     *
     * Called in process, the builder failed to resolve `./manager.ts` inside
     * `@elysian/log` — a relative import from a symlinked workspace package.
     * `bun build` gets it right, and it is also what anybody deploying this
     * would run.
     */
    const build = Bun.spawnSync({
      cmd: ['bun', 'build', './bootstrap/app.ts', '--target=bun', '--outdir', 'dist'],
      cwd: target,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    if (build.exitCode !== 0) {
      throw new Error(`build failed: ${new TextDecoder().decode(build.stderr)}`)
    }

    const text = await Bun.file(join(target, 'dist', 'app.js')).text()

    return { text, bytes: text.length }
  })()

  /**
   * Counted from the graph rather than from Bun's log line, which reports
   * modules across every entry point and is not addressable from here.
   */
  test(
    'it stays under six hundred modules',
    async () => {
      const { text } = await built
      const modules = [...text.matchAll(/^\/\/ .+\.tsx?$/gm)].length

      // 556 when this was written.
      expect<number>(modules).toBeLessThan(650)
    },
    PATIENCE
  )

  test(
    'and under 1.7 MB',
    async () => {
      const { bytes } = await built

      // 1.47 MB when this was written.
      expect<number>(bytes).toBeLessThan(1_700_000)
    },
    PATIENCE
  )

  /**
   * The four that cost the most, and that a landing page has no use for.
   *
   * Each stands for a decision rather than a size: `kysely` means the database
   * provider came back, `nodemailer` the mailer, `better-auth` the auth package,
   * `@opentelemetry/semantic-conventions` something in better-auth's tail.
   */
  test(
    'and carries none of what it does not use',
    async () => {
      const { text } = await built
      const found: string[] = []

      for (const name of [
        'kysely',
        'nodemailer',
        'better-auth',
        '@opentelemetry/semantic-conventions'
      ]) {
        if (text.includes(`node_modules/${name}/`)) found.push(name)
      }

      expect<string[]>(found).toEqual([])
    },
    PATIENCE
  )
})
