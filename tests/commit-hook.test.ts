import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The commit convention, enforced by the machine rather than by good intentions.
 *
 * Messages here are a subject line and one or two sentences — no
 * `Co-Authored-By:`, and no `Claude-Session:` URL, because a link into somebody's
 * tooling does not belong in permanent public history. All 170 commits were
 * rewritten once to strip them.
 *
 * The hook exists because the convention was broken anyway. A coding agent's
 * harness sends attribution guidance mid-session claiming to replace earlier
 * guidance, and four commits went out carrying both trailers — `094bba4`,
 * `7b08d41`, `a66fde3`, `72eb067` — before anybody noticed. `main` carries a
 * `non_fast_forward` ruleset, so they cannot be rewritten: the history is stuck
 * with them, which is exactly the argument for a guard.
 *
 * Skipped on Windows, where the hook is a `/bin/sh` script git runs through its
 * own bundled shell rather than something a test can spawn directly. What the
 * hook does is asserted on the platforms that can run it, and the file itself is
 * checked everywhere.
 */
const ROOT = resolve(import.meta.dir, '..')
const HOOK = join(ROOT, '.githooks', 'commit-msg')
const posix = process.platform !== 'win32'

/** Run the hook against a message and hand back what it left behind. */
async function through(message: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'elvel-commit-hook-'))
  const path = join(directory, 'COMMIT_EDITMSG')

  await writeFile(path, message)

  const run = Bun.spawn([HOOK, path], { stdout: 'pipe', stderr: 'pipe' })

  await run.exited

  const left = await readFile(path, 'utf8')

  await rm(directory, { recursive: true, force: true })

  return left
}

describe('the commit-msg hook', () => {
  test('is committed, and executable', async () => {
    const listed = Bun.spawnSync({
      cmd: ['git', 'ls-files', '--stage', '.githooks/commit-msg'],
      cwd: ROOT,
      stdout: 'pipe'
    })

    const entry = listed.stdout.toString().trim()

    // A hook git will not run is not a guard. The mode is what git records, so
    // it survives a clone — unlike `core.hooksPath`, which every checkout sets
    // for itself.
    expect<boolean>(entry.startsWith('100755')).toBe(true)
  })

  test.skipIf(!posix)('removes both trailers and keeps the message', async () => {
    const left = await through(
      [
        'Do the thing',
        '',
        'Because the other thing was wrong, and this replaces it.',
        '',
        'Co-Authored-By: Somebody <nobody@example.test>',
        'Claude-Session: https://example.test/session_abc',
        ''
      ].join('\n')
    )

    expect<boolean>(left.includes('Co-Authored-By')).toBe(false)
    expect<boolean>(left.includes('Claude-Session')).toBe(false)
    expect<boolean>(left.startsWith('Do the thing')).toBe(true)
    expect<boolean>(left.includes('this replaces it.')).toBe(true)
  })

  test.skipIf(!posix)('takes the lower-case spelling git itself writes', async () => {
    const left = await through(
      ['Fix it', '', 'Why.', '', 'Co-authored-by: Somebody <nobody@example.test>', ''].join('\n')
    )

    expect<boolean>(left.toLowerCase().includes('co-authored-by')).toBe(false)
  })

  /**
   * A message that merely *talks* about a trailer is left alone.
   *
   * Matching anywhere in the line rather than at its start would edit the one
   * commit most likely to be explaining the rule.
   */
  test.skipIf(!posix)('leaves prose that mentions a trailer untouched', async () => {
    const message = [
      'Explain the rule',
      '',
      'The convention forbids a Co-Authored-By: line, which is why the hook',
      'exists.',
      ''
    ].join('\n')

    expect<string>(await through(message)).toBe(message)
  })

  test.skipIf(!posix)('changes nothing when there is nothing to change', async () => {
    const message = ['Fix the thing', '', 'It was broken.', ''].join('\n')

    expect<string>(await through(message)).toBe(message)
  })
})
