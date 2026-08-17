import { rm } from 'node:fs/promises'
import { Command } from '../command.ts'

/**
 * `app:build` — bundle the application into one file.
 *
 * Laravel has nothing like this and does not need it: PHP compiles a file once
 * and keeps the opcodes, so a second request pays nothing for the first
 * request's parsing. Bun re-transpiles every module on every process, and there
 * is no cache between runs — `BUN_RUNTIME_TRANSPILER_CACHE_PATH` only holds
 * files above 50 KB, of which a framework of small modules has almost none.
 *
 * Measured on the auth kit, whose module graph is about a thousand files:
 *
 *     boot, from source     4005 ms   of which 3761 ms is loading modules
 *     boot, from a bundle    535 ms
 *     artisan list          4.019 s from source, 0.604 s from a bundle
 *
 * Nearly all of it is transpiling, not work the application asked for. Six per
 * cent of that boot was registering and booting every provider — which is why
 * this exists and Laravel's `DeferrableProvider`, the obvious answer, is not
 * what was built.
 *
 * The entry is `artisan.ts` rather than `bootstrap/app.ts`, because `artisan.ts`
 * reaches everything the application can do — `serve` included — and a bundle
 * that can only be imported is a bundle nothing can run.
 *
 * The output lands one directory below the application root, which is not a
 * style choice: `bootstrap/app.ts` derives the base path from its own location,
 * so a bundle two directories down would resolve `storage/` and `config/`
 * against the wrong root.
 */
export class AppBuildCommand extends Command {
  static override signature =
    'app:build {--minify : Minify the output} {--sourcemap : Write an external source map}'

  static override description = 'Bundle the application into dist/artisan.js'

  async handle(): Promise<number> {
    const entry = this.app.basePath('artisan.ts')

    if (!(await Bun.file(entry).exists())) {
      this.error('No artisan.ts at the application root, so there is nothing to build.')

      return 1
    }

    const out = this.app.basePath('dist')

    // Removed rather than overwritten: a stale `artisan.js.map` beside a bundle
    // built without one points at source that no longer matches.
    await rm(out, { recursive: true, force: true })

    const argv = ['bun', 'build', './artisan.ts', '--target=bun', '--outdir', 'dist']

    if (this.option('minify') === true) argv.push('--minify')
    if (this.option('sourcemap') === true) argv.push('--sourcemap=external')

    const build = Bun.spawnSync({
      cmd: argv,
      cwd: this.app.basePath(),
      stdout: 'pipe',
      stderr: 'pipe'
    })

    if (build.exitCode !== 0) {
      this.error('The build failed.')
      this.line(new TextDecoder().decode(build.stderr).trim())

      return 1
    }

    const bundle = Bun.file(this.app.basePath('dist', 'artisan.js'))

    this.output.tag('INFO', `Built dist/artisan.js (${(bundle.size / 1024 / 1024).toFixed(2)} MB)`)
    this.comment('  Run it with: bun dist/artisan.js serve')

    return 0
  }
}
