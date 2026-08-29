#!/usr/bin/env bun
/**
 * Anything that has to exist before the application does.
 *
 * Empty unless the kit needs it — the auth layer replaces the file with the one
 * import the passkey chain requires. A literal specifier, so the bundler sees it:
 * this used to be a guarded dynamic import in this file, which could not be
 * bundled and failed at run time from `dist/` in the kits Bun installs in the
 * isolated layout.
 */
import './bootstrap/polyfill.ts'

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Elvel entry point.
 *
 * The application is fully booted before commands run, which is why `serve`,
 * `route:list` and `about` can inspect the real container and route table.
 *
 * Booting is also what costs four seconds. Bun re-transpiles every module in
 * every process — around a thousand files here, most of them from packages
 * that ship as many small ones — and nothing is cached between runs, so
 * `elvel list` spends 4.019s to print a table and exit. The same command from
 * a bundle takes 0.604s.
 *
 * So if there is a bundle and it is newer than every source file, this hands
 * over to it. `elvel app:build` is what writes one; without it nothing here
 * changes, which is the point — a fast path nobody opted into is a fast path
 * that will one day run yesterday's code.
 */
const bundle = join(import.meta.dir, 'dist', 'elvel.js')

/**
 * `ELVEL_BUNDLE=0` runs from source with a bundle sitting right there.
 *
 * Without it the only way past the handover is deleting `dist/`, which is a
 * strange thing to have to do to compare the two — and the reason to compare is
 * usually that one of them is behaving differently from the other.
 */
if (process.env.ELVEL_BUNDLE !== '0' && (await fresh(bundle))) {
  const handed = Bun.spawnSync({
    cmd: ['bun', bundle, ...Bun.argv.slice(2)],
    cwd: process.cwd(),
    stdio: ['inherit', 'inherit', 'inherit']
  })

  /**
   * Say that the bundle ran, every time — not only when it fails.
   *
   * A silent handover is how stale code gets measured for hours: `bun.lock` does
   * not change when a linked dependency is edited, so the bundle stays "fresh"
   * while the source moves under it, and the command that was typed names
   * `elvel.ts`. One dim line on stderr, so a piped stdout stays clean.
   */
  process.stderr.write('  Running dist/elvel.js. ELVEL_BUNDLE=0 runs the source.\n')

  /**
   * Say which file failed, because the developer did not run it.
   *
   * A broken bundle reports itself with a stack trace full of `dist/elvel.js`
   * line numbers while the command that was typed names `elvel.ts` — and since
   * the handover is silent when it works, nothing on screen connects the two.
   * Measured once for real: `bun run build:server` on an application with
   * passkeys wrote a bundle that died at boot, and `bun run serve` — which had
   * worked a moment earlier and was not rebuilt — died with it.
   *
   * On stderr and only on failure: a note printed every time would end up inside
   * the output of every command that gets piped somewhere.
   */
  if ((handed.exitCode ?? 1) !== 0) {
    process.stderr.write(
      [
        '',
        '  That ran dist/elvel.js, not the source here — it is newer than every',
        '  source file, so this handed over to it. Run the source instead with',
        '  ELVEL_BUNDLE=0, or rebuild the bundle with `bun run build:server`.',
        '',
        ''
      ].join('\n')
    )
  }

  process.exit(handed.exitCode ?? 1)
}

const app = (await import('./bootstrap/app.ts')).default

const kernel = app.make('elvel')
const code = await kernel.run()

/**
 * Exit, unless the command left the server running.
 *
 * `serve` returns as soon as it is listening, because a command that never
 * returns leaves this module still evaluating — and `bun --hot` will not
 * re-evaluate a graph whose entry has not finished, so every edit needed a
 * restart. Measured: five successive edits to a view, five stale responses.
 *
 * So the exit is conditional. Nothing is holding the loop after an ordinary
 * command, and `process.exit` is what makes that immediate even when a driver
 * left a socket open; after `serve` the server is holding it, and exiting here
 * would close the thing that was just started.
 */
if (kernel.holdsProcess) process.exitCode = code
else process.exit(code)

/**
 * Is the bundle newer than everything it was built from?
 *
 * Compared by modification time rather than by content, because this runs
 * before every command and reading a thousand files to hash them would cost
 * more than it saves. The comparison is deliberately pessimistic: any source
 * file, `package.json` or `bun.lock` touched after the build makes it stale, and
 * a stale bundle is simply not used.
 *
 * `node_modules`, `storage` and `dist` itself are skipped — the first is
 * covered by `bun.lock`, and the other two are written while the application
 * runs, which would make every bundle stale the moment it served a request.
 *
 * So what this does *not* notice: a dependency edited in place. `bun.lock`
 * changes when a version does, not when somebody edits the code behind a
 * `file:` or `workspace:` link — which is exactly the arrangement inside the
 * framework's own repository, and any application developed alongside a package
 * it links to. The bundle stays "fresh" while the code it was built from moves.
 * `ELVEL_BUNDLE=0` is the way out; deleting `dist/` is the other.
 */
async function fresh(path: string): Promise<boolean> {
  const bundle = await stat(path).catch(() => undefined)

  if (!bundle) return false

  // Read out before the closure below, which cannot see the narrowing above.
  const builtAt = bundle.mtimeMs

  const skip = new Set(['node_modules', 'storage', 'dist', '.git', 'public'])

  async function newerThanBuild(directory: string): Promise<boolean> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (skip.has(entry.name)) continue

      const full = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (await newerThanBuild(full)) return true

        continue
      }

      if (!/\.(ts|tsx|json|lock)$/.test(entry.name)) continue

      const info = await stat(full).catch(() => undefined)

      if (info && info.mtimeMs > builtAt) return true
    }

    return false
  }

  return !(await newerThanBuild(import.meta.dir))
}
