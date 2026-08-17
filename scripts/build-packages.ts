#!/usr/bin/env bun
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Build every package to `dist/` — one JavaScript file, plus its declarations.
 *
 * Packages ship TypeScript source today, so an application installing
 * `@elvel/mail` gets sixteen modules to transpile rather than one file to parse.
 * Measured across all twenty-six, that is most of a boot: the auth kit went from
 * 4121 ms to 2293 ms with `main` pointed at built files, and a landing page from
 * 2047 ms to 1650 ms. Bun re-transpiles every module in every process and caches
 * nothing between runs, so this is the only place that cost can be removed.
 *
 * Three obstacles, each worked around here rather than lived with.
 *
 * **`"sideEffects": false` makes `bun build` emit a broken bundle.** Given an
 * entry that only re-exports — every `src/index.ts` here — Bun 1.3.14 writes
 * 0.55 KB containing an export list and no implementation, and importing it
 * throws `Exported binding … needs to refer to a top-level declared variable`.
 * There is no flag to ignore the annotation, so the field is taken out of the
 * manifest for the length of the build and put straight back. It cannot simply
 * go: it is what lets an application's bundler drop what it does not import.
 *
 * **Declarations come out referring to `.ts` files.** The source imports carry
 * extensions, so `tsc` emits `export { Config } from './config.ts'`, and a
 * consumer resolving that looks for `config.ts.d.ts`. Every specifier is
 * rewritten here instead of dropping extensions from twenty-six packages of
 * source, which would be a far larger change for the same result.
 *
 * **`noEmit` is set repository-wide**, so the emit needs `--noEmit false` as
 * well as `--emitDeclarationOnly`, or `tsc` writes nothing and says nothing.
 *
 * This does not touch `package.json`'s `exports` — `scripts/release.ts` does
 * that, for the tarball only, so development keeps running from source.
 */

const ROOT = resolve(import.meta.dir, '..')
const DECLARATIONS = join(ROOT, 'node_modules', '.cache', 'declarations')

/** Emit declarations for the whole repository in one pass, into a scratch tree. */
async function emitDeclarations(): Promise<void> {
  await rm(DECLARATIONS, { recursive: true, force: true })

  const run = Bun.spawnSync({
    cmd: [
      'bunx',
      'tsc',
      '-p',
      'tsconfig.json',
      '--declaration',
      '--emitDeclarationOnly',
      '--noEmit',
      'false',
      '--outDir',
      DECLARATIONS
    ],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe'
  })

  if (run.exitCode !== 0) {
    const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr)

    throw new Error(`tsc failed:\n${output.trim()}`)
  }
}

/** `from './config.ts'` -> `from './config'`, everywhere in a declaration file. */
function withoutExtensions(declaration: string): string {
  return declaration.replace(/(from\s*|import\(\s*)'(\.[^']*)\.ts'/g, "$1'$2'")
}

/** Copy one package's declarations into its `dist/`, extensions rewritten. */
async function declarationsFor(pkg: string): Promise<number> {
  const from = join(DECLARATIONS, 'packages', pkg, 'src')
  const to = join(ROOT, 'packages', pkg, 'dist')

  let written = 0

  const walk = async (directory: string, target: string): Promise<void> => {
    await mkdir(target, { recursive: true })

    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const source = join(directory, entry.name)

      if (entry.isDirectory()) {
        await walk(source, join(target, entry.name))

        continue
      }

      if (entry.name.endsWith('.d.ts')) {
        await writeFile(join(target, entry.name), withoutExtensions(await Bun.file(source).text()))
        written += 1

        continue
      }

      // `.d.ts.map` points at source that is not shipped; carried across anyway,
      // since an editor that cannot find it degrades rather than fails.
      await cp(source, join(target, entry.name))
    }
  }

  await walk(from, to)

  return written
}

/** Bundle one package, with the `sideEffects` claim lifted for the duration. */
async function bundle(pkg: string): Promise<number> {
  const path = join(ROOT, 'packages', pkg, 'package.json')
  const original = await Bun.file(path).text()
  const manifest = JSON.parse(original) as { sideEffects?: unknown }

  delete manifest.sideEffects

  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)

  try {
    const run = Bun.spawnSync({
      /**
       * `--packages=external` keeps every dependency out of the bundle.
       *
       * Only this package's own modules are collapsed, which is where the boot
       * cost is: `nodemailer` and `kysely` already arrive as single-file builds
       * from npm, and inlining them would ship each of them twice — once inside
       * the bundle and once as the declared dependency an installer fetches
       * anyway. Measured, it is the difference between 7.68 MB of output and a
       * fraction of it.
       */
      cmd: [
        'bun',
        'build',
        './src/index.ts',
        '--target=bun',
        '--packages=external',
        '--outdir',
        'dist'
      ],
      cwd: join(ROOT, 'packages', pkg),
      stdout: 'pipe',
      stderr: 'pipe'
    })

    if (run.exitCode !== 0) {
      throw new Error(`bun build failed:\n${new TextDecoder().decode(run.stderr).trim()}`)
    }
  } finally {
    await writeFile(path, original)
  }

  const built = Bun.file(join(ROOT, 'packages', pkg, 'dist', 'index.js'))

  /**
   * The guard against the `sideEffects` bug coming back — and the one package it
   * has to let through.
   *
   * A bundle that lost its implementation is a few hundred bytes *of export
   * list*: the names are all there and nothing behind them, so it fails only
   * when something imports it, which in a monorepo may be never. A types-only
   * package is small too, but empty — `@elvel/contracts` declares interfaces and
   * has no runtime at all, and its `export {}` is the correct answer.
   *
   * So the two are told apart by what is inside rather than by size.
   */
  if (built.size < 2_000) {
    const content = (await built.text()).replace(/\/\/ @bun/, '').trim()

    // Empty, or an empty export — `@elvel/contracts` comes out as the comment
    // Bun stamps on its output and nothing else.
    if (content !== '' && !/^export\s*\{\s*\}\s*;?$/.test(content)) {
      throw new Error(
        `dist/index.js is ${built.size} bytes of export list — the bundle lost its implementation`
      )
    }
  }

  return built.size
}

const packages = (await readdir(join(ROOT, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== 'create-elvel')
  .map((entry) => entry.name)
  .sort()

console.log('Emitting declarations for the whole repository…')

await emitDeclarations()

const failures: string[] = []
let bytes = 0
let declarations = 0

for (const pkg of packages) {
  await rm(join(ROOT, 'packages', pkg, 'dist'), { recursive: true, force: true })

  try {
    bytes += await bundle(pkg)
    declarations += await declarationsFor(pkg)
  } catch (problem) {
    failures.push(`@elvel/${pkg}: ${problem instanceof Error ? problem.message : problem}`)
  }
}

console.log(
  `\n${packages.length - failures.length} of ${packages.length} built — ` +
    `${(bytes / 1024 / 1024).toFixed(2)} MB of JavaScript, ${declarations} declaration files`
)

if (failures.length > 0) {
  console.log('\nFailed:')
  for (const failure of failures) console.log(`  ${failure}`)

  process.exit(1)
}

/** Nothing may still point at a `.ts` file, or a consumer's editor gives up. */
const offenders: string[] = []

for (const pkg of packages) {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)

      if (entry.isDirectory()) {
        await walk(path)

        continue
      }

      if (!entry.name.endsWith('.d.ts')) continue

      if (/(from\s*|import\(\s*)'\.[^']*\.ts'/.test(await Bun.file(path).text())) {
        offenders.push(path.slice(ROOT.length + 1))
      }
    }
  }

  await walk(join(ROOT, 'packages', pkg, 'dist'))
}

if (offenders.length > 0) {
  console.log('\nDeclarations still naming .ts files:')
  for (const offender of offenders) console.log(`  ${offender}`)

  process.exit(1)
}

console.log('No declaration names a .ts file.')
