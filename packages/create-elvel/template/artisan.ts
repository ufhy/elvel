#!/usr/bin/env bun
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Artisan entry point.
 *
 * The application is fully booted before commands run, which is why `serve`,
 * `route:list` and `about` can inspect the real container and route table.
 *
 * Booting is also what costs four seconds. Bun re-transpiles every module in
 * every process — around a thousand files here, most of them from packages
 * that ship as many small ones — and nothing is cached between runs, so
 * `artisan list` spends 4.019s to print a table and exit. The same command from
 * a bundle takes 0.604s.
 *
 * So if there is a bundle and it is newer than every source file, this hands
 * over to it. `artisan app:build` is what writes one; without it nothing here
 * changes, which is the point — a fast path nobody opted into is a fast path
 * that will one day run yesterday's code.
 */
const bundle = join(import.meta.dir, 'dist', 'artisan.js')

if (await fresh(bundle)) {
  const handed = Bun.spawnSync({
    cmd: ['bun', bundle, ...Bun.argv.slice(2)],
    cwd: process.cwd(),
    stdio: ['inherit', 'inherit', 'inherit']
  })

  process.exit(handed.exitCode ?? 1)
}

const app = (await import('./bootstrap/app.ts')).default

process.exit(await app.make('artisan').run())

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
