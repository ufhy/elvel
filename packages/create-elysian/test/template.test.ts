import { describe, expect, test } from 'bun:test'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

  /**
   * The template is the union, not what any one application installs.
   *
   * It has to name every package, because a kit is copied over it and cannot add
   * a dependency the base never mentioned. What each kit actually keeps is
   * decided after the copy, by reading the imports — see the scaffolding tests
   * further down.
   */
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
})

/**
 * Which providers a scaffolded application registers, and which it does not.
 *
 * It used to register all of them, and there was a test here demanding exactly
 * that. Laravel can afford the equivalent — its providers arrive inside one
 * Composer package whether or not they are used — but here each one is a
 * separate package, so a provider named in `bootstrap/providers.ts` is a package
 * installed, imported and bundled. Registering all twenty-two took a landing
 * page from 1.0 MB to 3.7 MB.
 *
 * So the rule is inverted now: a kit registers what it needs. What has to stay
 * true is narrower, and these are it.
 */
describe('the providers a kit registers', () => {
  /** Every `bootstrap/providers.ts` there is — the template's and each kit's. */
  async function providerLists(): Promise<Array<{ where: string; source: string }>> {
    const lists = [{ where: 'template', source: '' }]
    const kitsDir = resolve(import.meta.dir, '..', 'kits')

    for (const kit of (await readdir(kitsDir, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory()
    )) {
      lists.push({ where: kit.name, source: '' })
    }

    for (const list of lists) {
      const path =
        list.where === 'template'
          ? resolve(templateDir, 'bootstrap', 'providers.ts')
          : resolve(kitsDir, list.where, 'bootstrap', 'providers.ts')

      list.source = await Bun.file(path)
        .text()
        .catch(() => '')
    }

    // A kit with no file of its own inherits the template's, which is fine and
    // not something to assert against.
    return lists.filter((list) => list.source !== '')
  }

  /** `[[package, ProviderClass], …]`, read from the import lines. */
  function imported(source: string): Array<[string, string]> {
    return [...source.matchAll(/import \{ (\w+ServiceProvider) \} from '@elysian\/([\w-]+)'/g)].map(
      (match) => [match[2] as string, match[1] as string]
    )
  }

  test('every provider named is one its package actually exports', async () => {
    const wrong: string[] = []

    for (const { where, source } of await providerLists()) {
      for (const [pkg, provider] of imported(source)) {
        const file = Bun.file(resolve(root, 'packages', pkg, 'src', 'provider.ts'))

        if (!(await file.exists())) {
          wrong.push(`${where}: @elysian/${pkg} has no provider.ts`)
          continue
        }

        if (!(await file.text()).includes(`export class ${provider}`)) {
          wrong.push(`${where}: @elysian/${pkg} does not export ${provider}`)
        }
      }
    }

    expect<string[]>(wrong).toEqual([])
  })

  test('and every provider imported is also in the list', async () => {
    const unused: string[] = []

    for (const { where, source } of await providerLists()) {
      const listed = source.slice(source.indexOf('export const providers'))

      for (const [, provider] of imported(source)) {
        if (!new RegExp(`^\\s*${provider},?$`, 'm').test(listed)) {
          unused.push(`${where}: ${provider} imported but not registered`)
        }
      }
    }

    expect<string[]>(unused).toEqual([])
  })

  /**
   * The packages no kit registers at all.
   *
   * Named rather than counted, so a package arriving with a provider that
   * nothing ever registers is a decision somebody made rather than a number that
   * quietly went up. Each of these is reachable — `providers` is an ordinary
   * array in an ordinary file — but none of the three kits needs it, and none of
   * them should pay for it.
   */
  test('what nothing registers is what we expect nothing to register', async () => {
    const registered = new Set<string>()

    for (const { source } of await providerLists()) {
      for (const [pkg] of imported(source)) registered.add(pkg)
    }

    const never: string[] = []

    for (const name of await workspacePackages()) {
      const provider = Bun.file(resolve(root, 'packages', name, 'src', 'provider.ts'))

      if ((await provider.exists()) && !registered.has(name)) never.push(name)
    }

    expect<string[]>(never.sort()).toEqual([
      'broadcasting',
      'concurrency',
      'http-client',
      'image',
      'process'
    ])
  })
})

/**
 * `bootstrap/app.ts` names every config file, and has to keep naming them.
 *
 * The alternative — letting the framework read `config/` — is what a scaffolded
 * application did until now, and it cannot be built: the imports resolve against
 * a disk at run time, so a bundle contains no configuration and therefore no
 * providers, and boots into a container with nothing in it. Measured before the
 * change, `--kit=none` bundled 345 modules and could not start; the twenty-three
 * providers its own `config/app.ts` lists were simply not there.
 *
 * The cost of naming them is a list that drifts, which is what this holds shut.
 * A config file added without a line beside it is silently absent — `config()`
 * returns the default and nothing says why — so the failure this prevents is one
 * that looks like a wrong setting rather than a missing file.
 */
describe('the bootstrap can be followed by a bundler', () => {
  async function configFiles(directory: string): Promise<string[]> {
    const entries = await readdir(resolve(directory, 'config'))

    return entries
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => entry.slice(0, -'.ts'.length))
      .sort()
  }

  /** The keys of the object passed to `withConfig`. */
  async function namedInBootstrap(directory: string): Promise<string[]> {
    const source = await Bun.file(resolve(directory, 'bootstrap', 'app.ts')).text()

    return [...source.matchAll(/^\s*(\w+): \(\) => import\('\.\.\/config\/([\w-]+)\.ts'\)/gm)]
      .map((match) => {
        // Key and filename have to agree as well: `Config` stores what the key
        // says, so a mismatch files `config/mail.ts` under something nothing
        // reads.
        expect<string>(match[1] as string).toBe(match[2] as string)

        return match[1] as string
      })
      .sort()
  }

  test('the template names every config file it ships', async () => {
    expect<string[]>(await namedInBootstrap(templateDir)).toEqual(await configFiles(templateDir))
  })

  test('and so does the playground', async () => {
    const playground = resolve(root, 'playground')

    expect<string[]>(await namedInBootstrap(playground)).toEqual(await configFiles(playground))
  })

  /**
   * A kit may replace a config file, but adding one would need a line in
   * `bootstrap/app.ts` that the template cannot know about — so for now the rule
   * is that it may not, and this says so rather than leaving it to be found.
   */
  test('no kit ships a config file the template does not', async () => {
    const shipped = new Set(await configFiles(templateDir))
    const extra: string[] = []

    const kitsDir = resolve(import.meta.dir, '..', 'kits')

    for (const kit of (await readdir(kitsDir, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory()
    )) {
      for (const entry of await readdir(resolve(kitsDir, kit.name, 'config')).catch(() => [])) {
        if (entry.endsWith('.ts') && !shipped.has(entry.slice(0, -'.ts'.length))) {
          extra.push(`${kit.name}/${entry}`)
        }
      }
    }

    expect<string[]>(extra).toEqual([])
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
    //
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the `${…}` is
    // what is being asserted — it is the scaffolder's source, read as text.
    expect(source).toContain('APP_KEY=${key}')
    expect(source).toContain('AUTH_SECRET=${secret}')
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: as above.
  })
})

describe('every kit is a folder the installer knows about', () => {
  /**
   * A kit that exists on disk and not in `KITS` is invisible; one that is in
   * `KITS` and not on disk scaffolds the base template and says nothing. Both
   * failures are silent, which is why they are worth a test.
   */
  test('the two lists agree', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()
    const declared = [...source.matchAll(/^ {2}(\w[\w-]*): \{$/gm)].map(
      (match) => match[1] as string
    )

    const folders = (await readdir(resolve(import.meta.dir, '..', 'kits'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    // `none` is a kit with no folder: it is the base template, named.
    expect<string[]>(declared.filter((name) => name !== 'none').sort()).toEqual(folders)
  })

  test('each kit mounts a controller it actually ships', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()
    const missing: string[] = []

    // `[^}]` keeps the match inside one kit's own object: `[\s\S]` ran on past the
    // closing brace and paired `none` with the next kit's controller.
    for (const [, kit, controller] of source.matchAll(
      /^ {2}(\w[\w-]*): \{[^}]*?routes: \['\s*\.use\((\w+)\)'\]/gm
    )) {
      const path = resolve(
        import.meta.dir,
        '..',
        'kits',
        kit as string,
        'app/Http/Controllers',
        `${controller}.ts`
      )

      if (!(await Bun.file(path).exists())) missing.push(`${kit} mounts a missing ${controller}`)
    }

    expect<string[]>(missing).toEqual([])
  })
})

describe('the template ships nothing a test run left behind', () => {
  /**
   * A scaffolded application is whatever this directory contains, so anything
   * that lands here by accident lands in everybody's new project.
   *
   * It has happened: a `bun test` at the repository root found the template's
   * own example test, booted an application with the template as its base path,
   * and left `database/playground.sqlite` — plus, once WAL was on, two more
   * files beside it. All three were committed and would have been copied into
   * every scaffold.
   */
  test('no databases, no environment, no logs', async () => {
    const strays: string[] = []

    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name)

        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') strays.push(path)
          else await walk(path)

          continue
        }

        // `.env.example` is shipped on purpose; a real `.env` never is.
        if (/\.sqlite(-shm|-wal)?$/.test(entry.name)) strays.push(path)
        if (entry.name === '.env') strays.push(path)
        if (entry.name.endsWith('.log')) strays.push(path)
      }
    }

    await walk(templateDir)

    expect<string[]>(strays.map((path) => path.slice(templateDir.length + 1))).toEqual([])
  })
})

describe('the versions the template pins', () => {
  /**
   * A pin written from memory is a pin that is wrong.
   *
   * `vite` shipped as `^7.1.14` while 8 had been out for some time — and the
   * end-to-end check had actually run against 8, because `bun add` installs the
   * latest. So the template told people to install a major version older than
   * the one it was verified with, and nothing said so.
   *
   * This does not reach the network: it holds the pins to what the repository
   * itself uses, which is what gets exercised. A package the repository does not
   * use — `vite` is the only one — is listed here with the version it was
   * verified against, so bumping it is a decision somebody makes rather than a
   * number that drifts.
   */
  test('match what this repository uses, or say what they were tested with', async () => {
    const template = JSON.parse(await Bun.file(resolve(templateDir, '_package.json')).text()) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    const repository = JSON.parse(await Bun.file(resolve(root, 'package.json')).text()) as {
      devDependencies: Record<string, string>
    }

    const verifiedSeparately: Record<string, string> = { vite: '^8.2.1' }
    const mismatched: string[] = []

    for (const [name, pinned] of Object.entries({
      ...template.dependencies,
      ...template.devDependencies
    })) {
      if (pinned.startsWith('{{')) continue

      const here = repository.devDependencies[name] ?? verifiedSeparately[name]

      if (here && here !== pinned) mismatched.push(`${name}: template ${pinned}, here ${here}`)
    }

    expect<string[]>(mismatched).toEqual([])
  })
})

/**
 * What a scaffolded application ends up depending on.
 *
 * The template names all twenty-six framework packages; an application that
 * serves a landing page imports thirteen of them. The difference is not
 * cosmetic and not something a bundler can help with — an unused dependency is
 * downloaded, resolved, and written into the lockfile whether or not a single
 * line of it is ever reached.
 *
 * These scaffold for real, with `--no-install`, because the pruning happens
 * after the kit is copied over the template and reads the files that land. A
 * test against the template alone would be testing the wrong artefact.
 */
describe('what a scaffolded application installs', () => {
  const scaffolds = new Map<string, Record<string, string>>()

  async function dependencies(kit: string): Promise<Record<string, string>> {
    const cached = scaffolds.get(kit)
    if (cached) return cached

    const target = join(tmpdir(), `elysian-deps-${kit}-${process.pid}`)

    await rm(target, { recursive: true, force: true })

    const scaffolded = Bun.spawnSync({
      cmd: [
        'bun',
        resolve(import.meta.dir, '..', 'src', 'index.ts'),
        target,
        `--kit=${kit}`,
        '--no-install',
        '--force'
      ],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    expect<number>(scaffolded.exitCode).toBe(0)

    const manifest = (await Bun.file(join(target, 'package.json')).json()) as {
      dependencies: Record<string, string>
    }

    await rm(target, { recursive: true, force: true })

    scaffolds.set(kit, manifest.dependencies)

    return manifest.dependencies
  }

  test('an application with no auth does not install better-auth', async () => {
    const none = Object.keys(await dependencies('none'))

    expect<string[]>(none).not.toContain('better-auth')
    expect<string[]>(none).not.toContain('@elysian/auth')

    // Nor the packages behind the things it does not do.
    for (const absent of ['mail', 'queue', 'notifications', 'storage', 'hashing']) {
      expect<string[]>(none).not.toContain(`@elysian/${absent}`)
    }
  })

  test('and the auth kits do', async () => {
    for (const kit of ['auth', 'api']) {
      const installed = Object.keys(await dependencies(kit))

      expect<string[]>(installed).toContain('better-auth')
      expect<string[]>(installed).toContain('@elysian/auth')
      expect<string[]>(installed).toContain('@elysian/mail')
    }
  })

  /**
   * Two dependencies no import scan can see, and both would break the
   * application quietly: `elysia` arrives through `@elysian/http` rather than
   * through an import, and `@kitajs/html` is named by `tsconfig.json` as the JSX
   * runtime, which is a reference no scan of the source will ever find.
   */
  test('the invisible dependencies survive pruning', async () => {
    for (const kit of ['none', 'auth', 'api']) {
      const installed = Object.keys(await dependencies(kit))

      expect<string[]>(installed).toContain('elysia')
      expect<string[]>(installed).toContain('@kitajs/html')
    }
  })

  test('nothing is kept that the template did not offer', async () => {
    const template = (await Bun.file(resolve(templateDir, '_package.json')).json()) as {
      dependencies: Record<string, string>
    }

    const offered = new Set(Object.keys(template.dependencies))

    for (const kit of ['none', 'auth', 'api']) {
      for (const name of Object.keys(await dependencies(kit))) {
        expect<string>(`${kit}: ${name}`).toBe(
          offered.has(name) ? `${kit}: ${name}` : `${kit}: not offered by the template`
        )
      }
    }
  })
})
