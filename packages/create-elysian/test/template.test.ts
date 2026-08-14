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
   * The repository root must link them all too.
   *
   * Not cosmetic: the smoke test scaffolds an application *inside* this
   * checkout, and that application has no `node_modules` of its own, so it
   * resolves `@elysian/*` by walking up to the root's. A package the root does
   * not depend on is therefore absent from a scaffold that lists it — which is
   * exactly how `broadcasting` and `translation` got into the template and broke
   * the boot.
   */
  test('the repository root links every package', async () => {
    const manifest = await Bun.file(resolve(root, 'package.json')).json()
    const linked = Object.keys(manifest.devDependencies as Record<string, string>)
      .filter((name) => name.startsWith('@elysian/'))
      .map((name) => name.slice('@elysian/'.length))
      .sort()

    expect<string[]>(linked).toEqual(await workspacePackages())
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

/**
 * The secrets a scaffolded application starts with.
 *
 * The template used to ship `APP_KEY=change-me-to-32-characters-or-more`, which
 * `key:generate` counted as "already set" and refused to replace — so the first
 * command the scaffolder printed failed, and the application ran on a key
 * published in this repository. These hold that shut.
 */
describe('the template ships no secrets of its own', () => {
  test('APP_KEY and AUTH_SECRET are empty in the example', async () => {
    const example = await Bun.file(resolve(templateDir, '_env.example')).text()

    expect(example).toMatch(/^APP_KEY=$/m)
    expect(example).toMatch(/^AUTH_SECRET=$/m)
  })

  test('and no placeholder secret is left anywhere in the template', async () => {
    const suspects: string[] = []

    for await (const path of new Bun.Glob('**/*').scan({ cwd: templateDir, absolute: true })) {
      const text = await Bun.file(path)
        .text()
        .catch(() => '')

      // A value that looks like an instruction is a value somebody will ship.
      if (/change-me|changeme|your-secret-here/i.test(text)) suspects.push(path)
    }

    expect<string[]>(suspects).toEqual([])
  })

  test('the printed next steps do not include key:generate', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()
    const steps = source.match(/const start = \[[^\]]*\]/s)?.[0] ?? ''

    // The scaffolder fills both secrets in, so telling somebody to generate a key
    // would be telling them to rotate one they already have.
    expect(steps).not.toContain('key:generate')
    expect(steps).not.toContain('auth:secret')
    expect(steps).toContain('auth:schema')
  })

  test('the scaffolder writes a distinct value for each', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()

    // One value used for both would make a leak of either a leak of both.
    expect(source).toContain('APP_KEY=${key}')
    expect(source).toContain('AUTH_SECRET=${secret}')
  })
})
