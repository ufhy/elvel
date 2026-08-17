import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Application } from '@elvel/core'
import { ConfigPublishCommand } from '../src/commands/config-publish.ts'
import { Kernel } from '../src/kernel.ts'

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
   * The command resolves `@elvel/mail/config/mail.ts` from the application's
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
    const templateConfig = join(packagesDir, 'create-elvel', 'template', 'config')
    const differ: string[] = []

    for (const [name, pkg] of Object.entries(await shipped())) {
      const template = Bun.file(join(templateConfig, `${name}.ts`))

      if (!(await template.exists())) continue

      const theirs = (await template.text()).replace('{{ name }}', 'Elvel')
      const ours = await Bun.file(join(packagesDir, pkg, 'config', `${name}.ts`)).text()

      if (theirs !== ours) differ.push(name)
    }

    expect<string[]>(differ).toEqual([])
  })
})

/**
 * The scaffolder carries its own copy of the ownership map, and must not drift.
 *
 * `create-elvel` depends on no framework package — `bunx create-elvel`
 * should download a scaffolder, not a framework — so it cannot import this one.
 * A copy held to the original by a test is the trade: the alternative is a
 * scaffolded application that keeps a config file for a package it does not
 * install, or drops one it does.
 */
test('the scaffolder agrees about who owns what', async () => {
  const source = await Bun.file(join(packagesDir, 'create-elvel', 'src', 'index.ts')).text()

  const block = source.slice(
    source.indexOf('const CONFIG_OWNERS'),
    source.indexOf('}', source.indexOf('const CONFIG_OWNERS'))
  )

  const theirs = Object.fromEntries(
    [...block.matchAll(/^ {2}([\w-]+): '([\w-]+)'/gm)].map((match) => [match[1], match[2]])
  )

  expect<Record<string, string>>(theirs).toEqual(await mapped())
})

/**
 * The branch that only exists for an application without the package.
 *
 * `--kit=none` installs no mailer, so `config:publish mail` has nothing to copy —
 * and until now that path had never actually run. Inside this repository every
 * package resolves through the workspace root whether an application depends on
 * it or not, so `Bun.resolveSync` always succeeds and the error was unreachable
 * from any scaffolded application here.
 *
 * A temporary directory is what makes it reachable: resolution walks up from the
 * application's base path, and above `/tmp` there is no `node_modules` holding
 * `@elvel/mail`. Which is exactly the situation of a real application that
 * never installed it.
 */
describe('publishing a config whose package is absent', () => {
  let root: string
  let app: Application
  let kernel: Kernel

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'elvel-publish-'))
    await mkdir(join(root, 'config'), { recursive: true })

    app = new Application(root)
    kernel = new Kernel(app)
    kernel.register(ConfigPublishCommand)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Run a command, capturing what it printed with colours stripped. */
  async function run(argv: string[]): Promise<{ status: number; output: string }> {
    const lines: string[] = []
    const collect = (...args: unknown[]) => lines.push(args.map(String).join(' '))
    const log = console.log
    const error = console.error

    console.log = collect
    console.error = collect

    try {
      const status = await kernel.run(argv)

      return {
        status,
        output: lines
          .join('\n')
          .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
      }
    } finally {
      console.log = log
      console.error = error
    }
  }

  test('it says which package to install, and fails', async () => {
    const { status, output } = await run(['config:publish', 'mail'])

    expect<number>(status).toBe(1)
    expect<string>(output).toContain('[@elvel/mail] is not installed')
    expect<string>(output).toContain('bun add @elvel/mail')

    // And wrote nothing: a half-published config is worse than none, because the
    // file exists and the settings in it were never chosen.
    expect<boolean>(await Bun.file(join(root, 'config', 'mail.ts')).exists()).toBe(false)
  })

  /**
   * `--all` over the same application says nothing and succeeds.
   *
   * Deliberate: an application that installed six packages should not read
   * eleven errors about the twenty it did not, and `--all` means "everything
   * available to me", not "everything that exists".
   */
  test('but --all passes over what it cannot publish', async () => {
    const { status, output } = await run(['config:publish', '--all'])

    expect<number>(status).toBe(0)
    expect<string>(output).not.toContain('is not installed')
  })
})
