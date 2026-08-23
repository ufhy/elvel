import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * The lockfile must not name a directory this repository does not carry.
 *
 * `workspaces` includes `.demo/*`, and those directories are gitignored — they are
 * scratch applications that exist on one machine and in no checkout. So `bun
 * install` run with them present writes them into `bun.lock`, along with every
 * dependency they pull in, and CI installs with `--frozen-lockfile` against a
 * checkout where none of it exists.
 *
 * It cost four reverts of `bun.lock` in one afternoon before it was written down,
 * every one of them noticed by accident. The glob cannot simply go: the demos
 * declare `@elvel/*` as `workspace:*`, which only resolves for a workspace member.
 *
 * So this is the guard. It fails on the machine that has the demos, which is the
 * only machine that can create the problem, and it says what to do about it.
 */
const ROOT = join(import.meta.dir, '..')

/** Workspace paths as the lockfile lists them, from its `"workspaces"` block. */
async function workspacesInLockfile(): Promise<string[]> {
  const source = await Bun.file(join(ROOT, 'bun.lock')).text()
  const start = source.indexOf('"workspaces": {')

  expect<boolean>(start >= 0).toBe(true)

  /**
   * Read to the closing brace of that block by counting depth.
   *
   * The alternative — a regular expression over the whole file — matches package
   * entries further down that happen to look like paths, and a guard that reports
   * the wrong thing is worse than none.
   */
  let depth = 0
  let end = start

  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1

    if (depth === 0) {
      end = index
      break
    }
  }

  const block = source.slice(start, end)

  return [...block.matchAll(/^ {4}"([^"]+)": \{/gm)]
    .map((match) => match[1] as string)
    .filter((path) => path !== '')
}

describe('bun.lock names only what a checkout has', () => {
  test('every workspace it lists is tracked by git', async () => {
    const listed = await workspacesInLockfile()

    expect<boolean>(listed.length > 0).toBe(true)

    const untracked: string[] = []

    for (const path of listed) {
      const tracked = Bun.spawnSync({
        cmd: ['git', 'ls-files', '--error-unmatch', `${path}/package.json`],
        cwd: ROOT,
        stdout: 'ignore',
        stderr: 'ignore'
      })

      if (tracked.exitCode !== 0) untracked.push(path)
    }

    /**
     * The message is the point of the test, so the fix is *in* the message.
     *
     * What went wrong is invisible in a diff of a lockfile — hundreds of plausible
     * lines — and the thing that puts it there is routine: `bun run smoke`
     * installs at the root, so it happens without anybody asking for it.
     */
    expect<string>(
      untracked.length === 0
        ? 'bun.lock names only committed workspaces'
        : `bun.lock names ${untracked.join(', ')}, which no checkout has. Run: git checkout -- bun.lock`
    ).toBe('bun.lock names only committed workspaces')
  })
})
