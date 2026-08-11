#!/usr/bin/env bun
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import pc from 'picocolors'

/**
 * Regenerate `playground/` from the current template.
 *
 * DESTRUCTIVE: everything under `playground/` is deleted first, including the
 * hand-written exercise files that `scripts/smoke.ts` asserts against. Use it
 * after changing the template or the stubs, then restore the exercise files
 * from git (`git checkout playground`) or accept the plain skeleton.
 */

const root = join(import.meta.dir, '..')
const target = join(root, 'playground')

if (!Bun.argv.includes('--force')) {
  console.log(pc.yellow(`This deletes ${pc.bold('playground/')} and regenerates it.`))
  console.log(pc.dim('Re-run with --force to proceed:  bun run playground:reset --force'))
  process.exit(1)
}

await rm(target, { recursive: true, force: true })

const scaffold = Bun.spawnSync({
  cmd: ['bun', 'packages/create-elysian/src/index.ts', 'playground'],
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit'
})

if (scaffold.exitCode !== 0) process.exit(scaffold.exitCode)

const install = Bun.spawnSync({
  cmd: ['bun', 'install'],
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit'
})
if (install.exitCode !== 0) process.exit(install.exitCode)

console.log(pc.green('\nplayground/ regenerated.'))
console.log(pc.dim('Restore the smoke-test exercise files with: git checkout playground'))
