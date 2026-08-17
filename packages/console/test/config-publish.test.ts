import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * `config:publish` copies a default out of the package that owns it, so two
 * lists have to agree: the command's map of config name to package, and the
 * files those packages actually ship.
 *
 * Neither half fails loudly on its own. A package that gains a config file
 * nothing maps to is a file nobody can publish; a map entry pointing at a file
 * that is not there fails only when somebody asks for that exact name, which may
 * be months later. Both are cheap to catch here.
 */

const root = resolve(import.meta.dir, '..', '..', '..')
const packagesDir = join(root, 'packages')

/** `{ mail: 'mail', session: 'http', … }`, read from the command's source. */
async function mapped(): Promise<Record<string, string>> {
  const source = await Bun.file(
    resolve(import.meta.dir, '..', 'src', 'commands', 'config-publish.ts')
  ).text()

  const block = source.slice(source.indexOf('const OWNERS'), source.indexOf('/**', 1000))

  return Object.fromEntries(
    [...block.matchAll(/^ {2}([\w-]+): '([\w-]+)'/gm)].map((match) => [match[1], match[2]])
  ) as Record<string, string>
}

/** `{ mail: 'mail', … }`, read from what is on disk. */
async function shipped(): Promise<Record<string, string>> {
  const found: Record<string, string> = {}

  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const files = await readdir(join(packagesDir, entry.name, 'config')).catch(() => [])

    for (const file of files) {
      if (file.endsWith('.ts')) found[file.slice(0, -'.ts'.length)] = entry.name
    }
  }

  return found
}

describe('the config files a package can publish', () => {
  test('the command knows about every one that exists', async () => {
    expect<Record<string, string>>(await mapped()).toEqual(await shipped())
  })

  /**
   * A default is only reachable if its package exports it.
   *
   * The command resolves `@elysian/mail/config/mail.ts` from the application's
   * own directory, which goes through `exports` — a package that ships the file
   * without exporting it publishes nothing, and says only that the package is
   * not installed.
   */
  test('and every package exporting one says so in its exports', async () => {
    const missing: string[] = []

    for (const pkg of new Set(Object.values(await shipped()))) {
      const manifest = (await Bun.file(join(packagesDir, pkg, 'package.json')).json()) as {
        exports?: Record<string, string>
      }

      if (manifest.exports?.['./config/*'] !== './config/*') missing.push(pkg)
    }

    expect<string[]>(missing).toEqual([])
  })

  /**
   * Two config files belong to the application rather than to a package, and
   * neither can be published: `app.ts` imports `bootstrap/providers.ts`, which
   * exists only in an application, and `services.ts` is a place for the
   * application's own credentials. Laravel can publish its `app.php`; this is a
   * departure, and it is here so it stays a deliberate one.
   */
  test('app and services are not publishable', async () => {
    const owners = await mapped()

    expect<boolean>('app' in owners).toBe(false)
    expect<boolean>('services' in owners).toBe(false)
  })

  /**
   * What a package publishes and what the template ships must be the same file.
   *
   * They are two copies of one default, and they drift silently: a fix made in
   * the template reaches every new application and no published one, while a fix
   * made in the package reaches only the applications that publish. The template
   * substitutes the application's name into `config/mail.ts`, which is the one
   * difference this allows for.
   */
  test('a published default matches what a new application is given', async () => {
    const templateConfig = join(packagesDir, 'create-elysian', 'template', 'config')
    const differ: string[] = []

    for (const [name, pkg] of Object.entries(await shipped())) {
      const template = Bun.file(join(templateConfig, `${name}.ts`))

      if (!(await template.exists())) continue

      const theirs = (await template.text()).replace('{{ name }}', 'Elysian')
      const ours = await Bun.file(join(packagesDir, pkg, 'config', `${name}.ts`)).text()

      if (theirs !== ours) differ.push(name)
    }

    expect<string[]>(differ).toEqual([])
  })
})
