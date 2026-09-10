import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

/**
 * A stub is code that nothing compiles, and it broke exactly that way.
 *
 * `lens:install` publishes `lens-provider.stub` into an application, where it
 * imports `LensApplicationServiceProvider` from `@elvel/lens`. That export was
 * missing, and nothing said so: the file is a `.stub`, so `tsc` never reads it,
 * every test passed, and the failure arrived as
 * `SyntaxError: Export named 'LensApplicationServiceProvider' not found` the
 * first time somebody ran a command in a real application.
 *
 * So the two halves are held together here instead.
 */
async function stubs(): Promise<Array<{ name: string; source: string }>> {
  const directory = join(root, 'stubs')
  const found: Array<{ name: string; source: string }> = []

  for (const name of await readdir(directory)) {
    if (!name.endsWith('.stub')) continue

    found.push({ name, source: await Bun.file(join(directory, name)).text() })
  }

  return found
}

/** Every name a stub imports from `@elvel/lens`, type imports included. */
function importedFromLens(source: string): string[] {
  const names: string[] = []

  for (const match of source.matchAll(/import\s*{([^}]*)}\s*from\s*'@elvel\/lens'/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]

      if (name !== undefined && name !== '') names.push(name)
    }
  }

  return names
}

describe('the published stubs', () => {
  test('there is at least one, so this test cannot pass by finding nothing', async () => {
    expect((await stubs()).length).toBeGreaterThan(0)
  })

  test('every name they import from @elvel/lens is exported by it', async () => {
    const index = await Bun.file(join(root, 'src', 'index.ts')).text()
    const missing: string[] = []

    for (const { name, source } of await stubs()) {
      for (const imported of importedFromLens(source)) {
        // Matched against the export list rather than by importing, because a
        // stub is not a module this package can load.
        if (!new RegExp(`\\b${imported}\\b`).test(index)) {
          missing.push(`${name} imports ${imported}`)
        }
      }
    }

    expect<string[]>(missing).toEqual([])
  })

  test('and every helper they call is exported too', async () => {
    const index = await Bun.file(join(root, 'src', 'index.ts')).text()
    const missing: string[] = []

    for (const { name, source } of await stubs()) {
      for (const match of source.matchAll(/\b(lens|entryTypes)\(/g)) {
        const called = match[1] as string

        if (!new RegExp(`\\b${called}\\b`).test(index)) missing.push(`${name} calls ${called}()`)
      }
    }

    expect<string[]>(missing).toEqual([])
  })
})
