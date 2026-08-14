import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..', '..')
const templateDir = resolve(import.meta.dir, '..', 'template')

/** Every package in the workspace that a scaffolded application could use. */
async function workspacePackages(): Promise<string[]> {
  const entries = await readdir(resolve(root, 'packages'), { withFileTypes: true })

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== 'create-elysian')
    .sort()
}

/**
 * The scaffolder's package list is hand-maintained, so it drifts.
 *
 * It already had: `broadcasting` and `translation` were built, shipped, and
 * absent from the template, so a scaffolded application could not register
 * either provider — and nothing failed, because neither package contributes an
 * artisan command for the smoke test's registration check to miss.
 *
 * This is the check that catches the next one. It is deliberately a comparison
 * against the filesystem rather than a second list, because a second list drifts
 * in exactly the same way.
 */
describe('the template ships every package', () => {
  test('the installer knows about all of them', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()
    const block = source.match(/const FRAMEWORK_PACKAGES = \[([^\]]*)\]/)

    expect(block).not.toBeNull()

    const declared = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()

    expect<string[]>(declared as string[]).toEqual(await workspacePackages())
  })

  test("the template's package.json depends on all of them", async () => {
    const manifest = await Bun.file(resolve(templateDir, '_package.json')).json()
    const depended = Object.keys(manifest.dependencies as Record<string, string>)
      .filter((name) => name.startsWith('@elysian/'))
      .map((name) => name.slice('@elysian/'.length))
      .sort()

    expect<string[]>(depended).toEqual(await workspacePackages())
  })

  /**
   * Every package that *has* a provider must be registered.
   *
   * Not every package has one — `contracts`, `support` and `testing` are plain
   * libraries — so this reads the packages rather than assuming, which keeps it
   * true when the next package arrives without a provider.
   */
  test('config/app.ts registers every provider that exists', async () => {
    const config = await Bun.file(resolve(templateDir, 'config', 'app.ts')).text()
    const missing: string[] = []

    for (const name of await workspacePackages()) {
      const provider = Bun.file(resolve(root, 'packages', name, 'src', 'provider.ts'))
      if (!(await provider.exists())) continue

      const exported = (await provider.text()).match(/export class (\w+ServiceProvider)/)
      if (!exported) continue

      if (!config.includes(exported[1] as string)) missing.push(`${name} (${exported[1]})`)
    }

    expect<string[]>(missing).toEqual([])
  })
})
