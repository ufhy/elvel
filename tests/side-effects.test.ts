import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * `sideEffects` is a claim, and this is what keeps it true.
 *
 * Every package declares `"sideEffects": false`, which tells a bundler it may
 * drop any module nobody imported from. Measured once: without the claim,
 * importing `csrfField` from `@elvel/http` pulled 498 modules and 1.1 MB;
 * with it, five. What the claim costs is that it has to stay true — and the day
 * it stops being true, nothing here breaks. The tests run from source, where
 * every module is loaded anyway. What breaks is somebody else's bundled
 * application, silently, in a way that points nowhere near the module that
 * caused it.
 *
 * So the audit runs as a test. A module "acts on import" if it has a statement
 * at the top level that is not a declaration — a call, an assignment, anything
 * that does something when the file is first evaluated. Two modules genuinely
 * do, and both are named in their package's `sideEffects` rather than hidden by
 * a blanket `false`.
 */

const PACKAGES = join(import.meta.dir, '..', 'packages')

/** Template literals and block comments hold text that is not code. */
function strip(source: string): string {
  return source.replace(/`(?:[^`\\]|\\.)*`/gs, '``').replace(/\/\*.*?\*\//gs, '')
}

const DECLARATION =
  /^(export|import|const|let|var|type|class|abstract|function|async\s+function|interface|enum|declare|namespace)\b/

/** Files whose top level does something, as opposed to declaring something. */
function actsOnImport(source: string): boolean {
  return strip(source)
    .split('\n')
    .some((line) => {
      if (!line || ' \t}/)*]`\'"'.includes(line[0] as string)) return false

      return !DECLARATION.test(line)
    })
}

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) found.push(...(await sourceFiles(path)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(path)
  }

  return found
}

const packages = (await readdir(PACKAGES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe('what a package claims about its side effects', () => {
  test('every package makes the claim, one way or the other', async () => {
    for (const name of packages) {
      const manifest = JSON.parse(
        await readFile(join(PACKAGES, name, 'package.json'), 'utf8')
      ) as Record<string, unknown>

      // Absent is not the same as `false`: a bundler reading no field assumes
      // the worst, which is what cost 1.1 MB before any of this.
      expect<string>(`${name}: ${JSON.stringify(manifest.sideEffects)}`).not.toContain('undefined')
    }
  })

  test('nothing acts on import except what its package declares', async () => {
    const unexpected: string[] = []

    for (const name of packages) {
      const root = join(PACKAGES, name)
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        sideEffects?: false | string[]
      }

      const declared = new Set(
        Array.isArray(manifest.sideEffects)
          ? manifest.sideEffects.map((path) => join(root, path.replace(/^\.\//, '')))
          : []
      )

      for (const file of await sourceFiles(join(root, 'src'))) {
        if (!actsOnImport(await readFile(file, 'utf8'))) continue
        if (declared.has(file)) continue

        unexpected.push(file.slice(PACKAGES.length + 1))
      }
    }

    /**
     * If this fails, one of two things is true, and the fix differs.
     *
     * Either the module should not act on import — most do not need to, and a
     * registry that fills itself as a side effect of being imported is a
     * mechanism worth removing anyway — or it genuinely must, and its package
     * should name it: `"sideEffects": ["./src/that-file.ts"]`.
     */
    expect<string[]>(unexpected).toEqual([])
  })

  test('and the two that do are still the two that do', async () => {
    const named: string[] = []

    for (const name of packages) {
      const manifest = JSON.parse(await readFile(join(PACKAGES, name, 'package.json'), 'utf8')) as {
        sideEffects?: false | string[]
      }

      if (Array.isArray(manifest.sideEffects)) {
        named.push(...manifest.sideEffects.map((path) => `${name}${path.slice(1)}`))
      }
    }

    // Named rather than counted, so a third one arriving is a decision somebody
    // made on purpose and not a number that quietly went up.
    expect<string[]>(named.sort()).toEqual([
      'concurrency/src/worker-entry.ts',
      'create-elvel/src/index.ts'
    ])
  })
})
