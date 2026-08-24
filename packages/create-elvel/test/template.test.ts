import { describe, expect, test } from 'bun:test'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { MemorySessionDriver, Session, withRequestScope } from '@elvel/http'

const root = resolve(import.meta.dir, '..', '..', '..')
const templateDir = resolve(import.meta.dir, '..', 'template')

/** Every package in the workspace that a scaffolded application could use. */
async function workspacePackages(): Promise<string[]> {
  const entries = await readdir(resolve(root, 'packages'), { withFileTypes: true })

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== 'create-elvel')
    .sort()
}

/**
 * The scaffolder's package list is hand-maintained, so it drifts.
 *
 * It already had: `broadcasting` and `translation` were built, shipped, and
 * absent from the template, so a scaffolded application could not register
 * either provider — and nothing failed, because neither package contributes an
 * elvel command for the smoke test's registration check to miss.
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
      .filter((name) => name.startsWith('@elvel/'))
      .map((name) => name.slice('@elvel/'.length))
      .sort()

    expect<string[]>(depended).toEqual(await workspacePackages())
  })

  /**
   * The repository root must link them all too.
   *
   * Not cosmetic: the smoke test scaffolds an application *inside* this
   * checkout, and that application has no `node_modules` of its own, so it
   * resolves `@elvel/*` by walking up to the root's. A package the root does
   * not depend on is therefore absent from a scaffold that lists it — which is
   * exactly how `broadcasting` and `translation` got into the template and broke
   * the boot.
   */
  test('the repository root links every package', async () => {
    const manifest = await Bun.file(resolve(root, 'package.json')).json()
    const linked = Object.keys(manifest.devDependencies as Record<string, string>)
      .filter((name) => name.startsWith('@elvel/'))
      .map((name) => name.slice('@elvel/'.length))
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
    return [...source.matchAll(/import \{ (\w+ServiceProvider) \} from '@elvel\/([\w-]+)'/g)].map(
      (match) => [match[2] as string, match[1] as string]
    )
  }

  test('every provider named is one its package actually exports', async () => {
    const wrong: string[] = []

    for (const { where, source } of await providerLists()) {
      for (const [pkg, provider] of imported(source)) {
        const file = Bun.file(resolve(root, 'packages', pkg, 'src', 'provider.ts'))

        if (!(await file.exists())) {
          wrong.push(`${where}: @elvel/${pkg} has no provider.ts`)
          continue
        }

        if (!(await file.text()).includes(`export class ${provider}`)) {
          wrong.push(`${where}: @elvel/${pkg} does not export ${provider}`)
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
type Scaffold = {
  dependencies: Record<string, string>
  manifest: Record<string, unknown>
  target: string
  configs: string[]
  bootstrap: string
}

const scaffolds = new Map<string, Scaffold>()

async function scaffold(kit: string): Promise<Scaffold> {
  const cached = scaffolds.get(kit)
  if (cached) return cached

  const target = join(tmpdir(), `elvel-deps-${kit}-${process.pid}`)

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

  // The child's own output, or a failure here says only "1" — which is what a
  // Windows run reported for a fortnight.
  expect<string>(
    `${scaffolded.exitCode}: ${new TextDecoder().decode(scaffolded.stdout)}${new TextDecoder().decode(scaffolded.stderr)}`.slice(
      0,
      900
    )
  ).toStartWith('0:')

  const manifest = (await Bun.file(join(target, 'package.json')).json()) as {
    dependencies: Record<string, string>
  }

  const built: Scaffold = {
    dependencies: manifest.dependencies,
    manifest: manifest as unknown as Record<string, unknown>,
    target,
    configs: (await readdir(join(target, 'config')))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => entry.slice(0, -'.ts'.length))
      .sort(),
    bootstrap: await Bun.file(join(target, 'bootstrap', 'app.ts')).text()
  }

  await rm(target, { recursive: true, force: true })

  scaffolds.set(kit, built)

  return built
}

async function dependencies(kit: string): Promise<Record<string, string>> {
  return (await scaffold(kit)).dependencies
}

describe('what a scaffolded application installs', () => {
  test('an application with no auth does not install better-auth', async () => {
    const none = Object.keys(await dependencies('none'))

    expect<string[]>(none).not.toContain('better-auth')
    expect<string[]>(none).not.toContain('@elvel/auth')

    /**
     * Nor the packages behind the things it does not do — the database
     * included.
     *
     * That one is the deliberate answer to "what does a landing page get?": no
     * database at all, rather than an empty `database/` directory beside a
     * config file for a connection nothing opens. `@elvel/database` brings
     * `kysely`, some 660 KB, and adding it back is `bun add`, `config:publish
     * database`, and one line in `bootstrap/providers.ts`.
     */
    for (const absent of ['database', 'mail', 'queue', 'notifications', 'storage', 'hashing']) {
      expect<string[]>(none).not.toContain(`@elvel/${absent}`)
    }
  })

  test('and the auth kits do', async () => {
    for (const kit of ['auth', 'api']) {
      const installed = Object.keys(await dependencies(kit))

      expect<string[]>(installed).toContain('better-auth')
      expect<string[]>(installed).toContain('@elvel/auth')
      expect<string[]>(installed).toContain('@elvel/mail')
    }
  })

  /**
   * Two dependencies no import scan can see, and both would break the
   * application quietly: `elysia` arrives through `@elvel/http` rather than
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

  /**
   * Nothing appears from nowhere.
   *
   * Two places may put a runtime dependency in a scaffolded manifest: the
   * template, which lists the union of what any kit might import, and a kit's own
   * `manifest.json` — which is how the auth kits get `uqr` to draw a QR code for
   * the two-factor page, a package no other kit has any use for.
   *
   * Anything else means the prune kept a name that nobody declared, which is how
   * an application ends up installing something it cannot resolve.
   */
  /**
   * The polyfill a bundled application cannot boot without.
   *
   * `tsyringe` throws while its own module evaluates if `Reflect.getMetadata` is
   * missing, and it arrives under passkeys — `@better-auth/passkey` →
   * `@peculiar/x509` → `tsyringe`. From source the evaluation order happened to
   * be kind; `bun build` reached `tsyringe` first, so `bun run build:server`
   * wrote a bundle that died at boot naming a package the application never
   * imported. That is the production deploy path, and it was broken.
   *
   * Two halves, and either one alone is useless: the entry has to load the
   * polyfill *before* the application it boots, and the kit that brings the
   * passkey chain has to declare it so the specifier resolves.
   */
  /**
   * The handover to `dist/elvel.js` has to be escapable and legible.
   *
   * `elvel.ts` runs the bundle whenever it is newer than every source file, and
   * says nothing when it works — so when a bundle is broken, the developer reads
   * a stack trace full of `dist/elvel.js` line numbers for a command that names
   * `elvel.ts`. Measured for real: one `bun run build:server` on an application
   * with passkeys took `bun run serve` down with it, and nothing on screen
   * connected the two.
   *
   * Staleness has a blind spot that makes an escape hatch necessary rather than
   * merely convenient — a dependency linked with `workspace:` or `file:` can be
   * edited without `bun.lock` changing, so the bundle stays "fresh" while the
   * code behind it moves.
   */
  test('the bundle handover can be escaped and explains itself', async () => {
    const entry = await Bun.file(resolve(templateDir, 'elvel.ts')).text()

    // The way out is checked before the freshness walk, not after it.
    const bypass = entry.indexOf("process.env.ELVEL_BUNDLE !== '0'")
    const handover = entry.indexOf('Bun.spawnSync')

    expect(bypass).toBeGreaterThan(-1)
    expect(bypass).toBeLessThan(handover)

    /**
     * Two messages, both on stderr so no command's stdout gains a line.
     *
     * The first is unconditional, and it earned that: a silent handover is how
     * stale code gets measured for hours — `bun.lock` does not move when a linked
     * dependency is edited, so the bundle stays "fresh" while the source changes
     * under it. The second only fires when the bundle exits non-zero, because a
     * stack trace full of `dist/elvel.js` needs to name the file that ran.
     */
    const announcement = entry.indexOf('Running dist/elvel.js')
    const failure = entry.indexOf('not the source here')

    expect(announcement).toBeGreaterThan(handover)
    expect(entry.slice(handover, announcement)).not.toContain('exitCode')
    expect(entry.slice(announcement, announcement + 200)).toContain('ELVEL_BUNDLE=0')

    expect(failure).toBeGreaterThan(announcement)
    expect(entry.slice(announcement, failure)).toContain('handed.exitCode ?? 1) !== 0')
  })

  test('a passkey application can boot from its bundle', async () => {
    const entry = await Bun.file(resolve(templateDir, 'elvel.ts')).text()

    /**
     * Through a variable, and that part is not cosmetic.
     *
     * Only the auth kit declares this dependency, so a literal specifier makes
     * `bun run typecheck` fail in every other application with
     * `Cannot find module 'reflect-metadata'` — measured on a scaffolded app
     * before the indirection went in. A non-literal specifier tells TypeScript to
     * leave the resolution to run time, which is what the `try` is for.
     */
    const polyfill = entry.indexOf("'reflect-metadata'")
    const application = entry.indexOf("await import('./bootstrap/app.ts')")

    expect(polyfill).toBeGreaterThan(-1)
    expect(polyfill).toBeLessThan(application)
    expect(entry).not.toContain("await import('reflect-metadata')")
    expect(entry.slice(polyfill, application)).toContain('await import(polyfill)')

    // Guarded, because every kit but `auth` declares no such dependency and
    // needs no polyfill.
    expect(entry.slice(0, polyfill)).toContain('try {')

    const auth = (await Bun.file(
      resolve(import.meta.dir, '..', 'kits', 'auth', 'manifest.json')
    ).json()) as { dependencies?: Record<string, string> }

    expect(auth.dependencies?.['reflect-metadata']).toBeDefined()
  })

  test('nothing is kept that neither the template nor a kit offered', async () => {
    const template = (await Bun.file(resolve(templateDir, '_package.json')).json()) as {
      dependencies: Record<string, string>
    }

    const offered = new Set(Object.keys(template.dependencies))
    const kits = resolve(import.meta.dir, '..', 'kits')

    for (const kit of await readdir(kits)) {
      const manifest = Bun.file(join(kits, kit, 'manifest.json'))

      if (!(await manifest.exists())) continue

      const declared = (await manifest.json()) as { dependencies?: Record<string, string> }

      for (const name of Object.keys(declared.dependencies ?? {})) offered.add(name)
    }

    for (const kit of ['none', 'auth', 'api']) {
      for (const name of Object.keys(await dependencies(kit))) {
        expect<string>(`${kit}: ${name}`).toBe(
          offered.has(name) ? `${kit}: ${name}` : `${kit}: declared by nobody`
        )
      }
    }
  })
})

/**
 * Which config files a scaffolded application is given.
 *
 * Laravel 11 slimmed its skeleton to ten and left the rest to `config:publish`.
 * The idea is borrowed; the list is not. Laravel's ten are chosen for an
 * application that always has every component, and two of them — `mail` and
 * `queue` — would be settings for packages `--kit=none` does not install, while
 * `view` and `vite`, in neither Laravel's ten nor its framework defaults, are
 * read on every page it serves.
 *
 * So a config file ships when its package does. These are the results, named
 * rather than counted, because a file quietly appearing or vanishing changes
 * what an application is configured with.
 */
describe('the config files a kit ships', () => {
  test('a landing page gets ten, and they are these ten', async () => {
    expect<string[]>((await scaffold('none')).configs).toEqual([
      'app',
      'cache',
      'cors',
      'http',
      'logging',
      'security',
      'services',
      'session',
      'view',
      'vite'
    ])
  })

  test('the auth kit adds what signing in needs', async () => {
    const added = (await scaffold('auth')).configs.filter(
      (name) => !(scaffolds.get('none') as { configs: string[] }).configs.includes(name)
    )

    expect<string[]>(added).toEqual([
      'auth',
      'database',
      'filesystems',
      'hashing',
      'mail',
      'notifications',
      'queue'
    ])
  })

  test('and the api kit the same, without the file storage', async () => {
    const auth = (await scaffold('auth')).configs
    const api = (await scaffold('api')).configs

    expect<string[]>(auth.filter((name) => !api.includes(name))).toEqual(['filesystems'])
  })

  /**
   * Every file shipped is named, and nothing else is.
   *
   * The two halves fail differently and both quietly. A config file with no line
   * in `withConfig` is never read — `config('mail.default')` returns the default
   * and nothing says the file was skipped. A line with no file behind it is
   * worse: `Cannot find module` at boot, naming a path rather than a config.
   */
  test('bootstrap/app.ts names exactly the files that are there', async () => {
    for (const kit of ['none', 'auth', 'api']) {
      const { configs, bootstrap } = await scaffold(kit)

      const named = [...bootstrap.matchAll(/import\('\.\.\/config\/([\w-]+)\.ts'\)/g)]
        .map((match) => match[1] as string)
        .sort()

      expect<string[]>(named).toEqual(configs)
    }
  })
})

/**
 * The version a scaffolded application asks for.
 *
 * `create-elvel@1.0.0-alpha.1` wrote `^0.0.1` for every framework package —
 * a version no `@elvel/*` package has ever carried — so `bunx create-elvel`
 * produced an application whose `bun install` answered 404 twenty-six times. It
 * could not fail here, because a scaffold inside this checkout is a workspace
 * member and gets `workspace:*` instead, which is the one path the tests took.
 *
 * So this asserts the other path: the range written outside a workspace has to be
 * the installer's own version, since the packages are released in lockstep with
 * it.
 */
describe('what a scaffolded application asks npm for', () => {
  test('the installer never invents a version', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()

    // A literal range in the scaffolder is how `^0.0.1` survived: it read as a
    // sensible default and was true of nothing.
    const literal = source.match(
      /dep_\$\{name\}`,\s*\n?\s*workspaceMode \? 'workspace:\*' : '([^']+)'/
    )

    expect(literal).toBeNull()
  })

  test('and asks for its own version', async () => {
    const manifest = (await Bun.file(resolve(import.meta.dir, '..', 'package.json')).json()) as {
      version: string
    }

    const target = join(tmpdir(), `elvel-range-${process.pid}`)

    await rm(target, { recursive: true, force: true })

    const scaffolded = Bun.spawnSync({
      cmd: [
        'bun',
        resolve(import.meta.dir, '..', 'src', 'index.ts'),
        target,
        '--kit=none',
        '--no-install',
        '--force'
      ],
      cwd: tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe'
    })

    // The child's own output, or a failure here says only "1" — which is what a
    // Windows run reported for a fortnight.
    expect<string>(
      `${scaffolded.exitCode}: ${new TextDecoder().decode(scaffolded.stdout)}${new TextDecoder().decode(scaffolded.stderr)}`.slice(
        0,
        900
      )
    ).toStartWith('0:')

    const written = (await Bun.file(join(target, 'package.json')).json()) as {
      dependencies: Record<string, string>
    }

    await rm(target, { recursive: true, force: true })

    // Outside the checkout there is no workspace to link, so every framework
    // package has to name a version npm can actually resolve.
    expect<string>(written.dependencies['@elvel/core'] as string).toBe(`^${manifest.version}`)
  })
})

/**
 * The manifest the scaffolder writes has to parse.
 *
 * It did not, on Windows, for as long as the check existed: the project name was
 * taken with `name.replace(/^.*\//, '')`, which cuts at the last *forward* slash,
 * so an absolute target left `D:\a\elvel\…` in `"name"` — and `\a` is not a JSON
 * escape. The scaffolder then failed reading the file it had just written, with
 * Bun reporting only `Failed to parse JSON`.
 *
 * Asserting the name rather than the parse is what makes this catch it here: on a
 * machine with forward slashes the broken version produced valid JSON, so only
 * the wrong *value* gives it away.
 */
describe('the manifest a scaffold is given', () => {
  test('names the project after its directory, not its path', async () => {
    const { manifest, target } = await scaffold('none')

    expect<string>(manifest.name as string).toBe(basename(target))
  })
})

/**
 * What the scaffolded README promises, and what the application can actually do.
 *
 * The README it replaced had drifted into four falsehoods: it linked to
 * `https://github.com/` with no path, told the reader to run `bun install` and
 * copy `.env` when the scaffolder had already done both, and listed `make:model`,
 * `migrate` and `db:seed` — none of which exist in an application with no
 * database, which is what `--kit=none` is.
 *
 * Nothing about that fails a test or a boot. It fails a person, on their first
 * five minutes. So the claims are checked here.
 */
describe('the README a scaffolded application is given', () => {
  const readme = async (): Promise<string> =>
    await Bun.file(resolve(templateDir, 'README.md')).text()

  test('every command it shows exists in the kit that ships it', async () => {
    const text = await readme()

    /**
     * Only the commands shown *before* `## Adding a database`.
     *
     * That section documents `make:model`, `migrate` and `db:seed` on purpose —
     * behind an explicit `bun add @elvel/database`, which is the whole point of
     * it. What must not happen is the earlier sections naming a command this
     * application does not have, which is exactly how the previous README came to
     * promise a database to a kit that has none.
     */
    const upfront = text.slice(0, text.indexOf('## Adding a database'))

    // `bun run elvel <command>` — the form the README uses throughout.
    const shown = [...upfront.matchAll(/bun run elvel ([a-z][\w:-]*)/g)]
      .map((match) => match[1] as string)
      .filter((name) => name !== 'elvel')

    expect<number>(shown.length).toBeGreaterThan(8)

    /**
     * Read from the packages the base template registers rather than from a
     * running application: a test that boots one would need an install, and the
     * question here is only whether the command's provider is in the list.
     */
    const providers = await Bun.file(resolve(templateDir, 'bootstrap', 'providers.ts')).text()
    const registered = new Set(
      [...providers.matchAll(/from '@elvel\/([\w-]+)'/g)].map((match) => match[1] as string)
    )

    const commands = new Map<string, string>()

    for (const pkg of [...registered, 'console']) {
      const dir = resolve(root, 'packages', pkg, 'src')

      for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: dir, absolute: true })) {
        for (const match of (await Bun.file(path).text()).matchAll(
          /static override signature =\s*\n?\s*'([a-z][\w:-]*)/g
        )) {
          commands.set(match[1] as string, pkg)
        }
      }
    }

    const missing = shown.filter((name) => !commands.has(name))

    expect<string[]>(missing).toEqual([])
  })

  test('and it does not tell the reader to install what is already installed', async () => {
    const text = await readme()
    const start = text.slice(text.indexOf('## Getting started'), text.indexOf('## Commands'))

    // The scaffolder runs the install, writes the `.env` with its own secrets and
    // migrates. Telling somebody to do it again is how `key:generate` came to be
    // in a README while the scaffolder refused to run it.
    expect<boolean>(start.includes('bun install')).toBe(false)
    expect<boolean>(start.includes('cp .env.example')).toBe(false)
    expect<boolean>(start.includes('key:generate')).toBe(false)
  })

  /**
   * And the database section is the only place those commands may appear.
   *
   * The pairing matters: the check above trusts that section to be the exception,
   * so this one holds it to being the exception.
   */
  test('and the database commands appear only where they are earned', async () => {
    const text = await readme()
    const upfront = text.slice(0, text.indexOf('## Adding a database'))

    for (const command of ['make:model', 'migrate', 'db:seed', 'db:show']) {
      expect<string>(`${command}: ${upfront.includes(command)}`).toBe(`${command}: false`)
    }
  })

  test('and every link in it has somewhere to go', async () => {
    const bare = [...(await readme()).matchAll(/\]\((https?:\/\/[^)]*)\)/g)]
      .map((match) => match[1] as string)
      .filter((url) => /^https?:\/\/[^/]+\/?$/.test(url))

    // `[Elvel](https://github.com/)` shipped for weeks.
    expect<string[]>(bare).toEqual([])
  })
})

/**
 * The page a new application answers with.
 *
 * Laravel's `welcome.blade.php` inlines its stylesheet so the first thing anybody
 * sees is finished rather than unstyled, and ours has to do the same for a
 * sharper reason: `vite()` renders nothing until `bun run build` has run, so
 * before that a scaffolded application served 1,295 bytes of naked markup.
 */
describe('the welcome page', () => {
  const welcome = async (): Promise<string> =>
    await Bun.file(resolve(templateDir, 'resources', 'views', 'pages', 'welcome.tsx')).text()

  test('carries its own styles, so it looks right before any build', async () => {
    const source = await welcome()

    expect<boolean>(source.includes('<style>{styles}</style>')).toBe(true)

    // The page-level basics too. `app.css` says the same things and arrives only
    // through the build, so without these the body keeps the browser's margin.
    expect<boolean>(/body \{[^}]*margin: 0/.test(source)).toBe(true)
    expect<boolean>(source.includes('prefers-color-scheme: dark')).toBe(true)
    expect<boolean>(source.includes('prefers-reduced-motion')).toBe(true)
  })

  /**
   * A grid item does not shrink below its content unless told to, and the
   * terminal block is `white-space: pre`. Without `min-width: 0` the column
   * holds itself open, `overflow-x` never engages, and the whole page scrolled
   * sideways on a phone — 414 pixels inside a 390-pixel viewport, measured in a
   * browser.
   */
  test('and does not push the page sideways on a phone', async () => {
    expect<boolean>((await welcome()).includes('.welcome .col { min-width: 0; }')).toBe(true)
  })

  /**
   * The header offers only what the application has.
   *
   * `--kit=none` names no auth routes and it stays empty; a kit that ships
   * sign-in names them and it fills in — the same question Laravel's welcome page
   * asks with `Route::has('login')`, and the same reason: a starter page must not
   * link to a page that answers 404.
   */
  test('and links to auth pages only where they exist', async () => {
    const controller = await Bun.file(
      resolve(templateDir, 'app', 'Http', 'Controllers', 'PageController.ts')
    ).text()

    for (const name of ['login', 'register', 'dashboard']) {
      expect<string>(`${name}: ${controller.includes(`routes().path('${name}')`)}`).toBe(
        `${name}: true`
      )
    }

    // And the kit that has those pages names them, or the header stays empty in
    // the one application that should show it.
    const named = await Promise.all(
      [
        ['Auth/SignInController.ts', 'login'],
        ['Auth/RegisterController.ts', 'register'],
        ['DashboardController.ts', 'dashboard']
      ].map(async ([file, name]) => {
        const source = await Bun.file(
          resolve(
            import.meta.dir,
            '..',
            'kits',
            'auth',
            'app',
            'Http',
            'Controllers',
            file as string
          )
        ).text()

        return `${name}: ${source.includes(`${name}:`) && source.includes('routes().names(')}`
      })
    )

    expect<string[]>(named).toEqual(['login: true', 'register: true', 'dashboard: true'])
  })
})

/**
 * Live reload, which nothing underneath provides.
 *
 * Bun's `--hot` re-evaluates the server's modules and its own documentation says
 * plainly that it "is not the same as hot reloading in the browser"; Elysia has
 * no equivalent. The only socket a browser is already listening on belongs to
 * Vite, so a plugin in the template pushes a full reload down it — and these
 * tests exist because that arrangement is easy to take apart by accident.
 */
describe('reloading the browser', () => {
  /**
   * The plugin the template ships, loaded and run rather than read.
   *
   * The predicate that made this necessary was `file.includes('app')`, which read
   * fine — every watched directory appeared in the file — and was wrong for two
   * paths that matter: an application in `apps/demo` matched every file it owns,
   * and `resources/css/app.css` turned a CSS hot update into a full page reload.
   * No amount of reading the string would have said so.
   *
   * The working directory moves for the same reason. `@elvel/vite` finds the
   * application by walking up for an `elvel.ts`, which is what lets one plugin
   * serve both layouts — so the test has to stand where a developer stands.
   */
  async function templatePlugin(command: string): Promise<{
    config: { base?: string; server?: { watch?: { ignored?: string[] } } }
    plugin: { name: string; configureServer?(server: unknown): void }
  }> {
    const cwd = process.cwd()

    try {
      process.chdir(templateDir)

      const loaded = (await import(join(templateDir, 'vite.config.ts'))) as {
        default: {
          plugins: Array<{
            name: string
            config(user: object, env: { command: string }): object
            configureServer?(server: unknown): void
          }>
        }
      }

      const plugin = loaded.default.plugins.find((one) => one.name === 'elvel')

      if (plugin === undefined) throw new Error('The template ships no `elvel` plugin.')

      return { config: plugin.config({}, { command }), plugin }
    } finally {
      process.chdir(cwd)
    }
  }

  test('the refresh plugin sends a reload for views and for nothing else', async () => {
    const { plugin } = await templatePlugin('serve')
    const handlers: Array<(file: string) => void> = []
    let sent = 0

    plugin.configureServer?.({
      watcher: {
        add: () => undefined,
        on: (_event: string, handler: (file: string) => void) => handlers.push(handler)
      },
      hot: { send: () => sent++ }
    })

    /**
     * Forward slashes, even on Windows.
     *
     * Vite normalises watcher paths to posix separators on every platform, and the
     * plugin compares against roots it normalises the same way — so a test that
     * fed `join()`'s backslashes was testing a path Vite would never hand over,
     * and only Windows CI said so.
     */
    const reloads = (file: string): number => {
      sent = 0

      const path = join(templateDir, file).replaceAll('\\', '/')

      for (const handler of handlers) handler(path)

      return sent
    }

    // Rendered on the server, so the browser has no module to swap.
    expect(reloads('resources/views/pages/welcome.tsx')).toBeGreaterThan(0)
    expect(reloads('app/Http/Controllers/PageController.ts')).toBeGreaterThan(0)

    // Real client modules, which keep their own HMR.
    expect(reloads('resources/css/app.css')).toBe(0)
    expect(reloads('resources/js/app.ts')).toBe(0)

    // Written by the running application, and not the browser's business.
    expect(reloads('storage/framework/sessions/abc.json')).toBe(0)
    expect(reloads('database/database.sqlite')).toBe(0)
    expect(reloads('public/build/manifest.json')).toBe(0)
  })

  /**
   * The other half of the same loop.
   *
   * Rejecting those paths in the plugin is not enough, because Vite watches the
   * project root itself. A request writes a session file, the watcher wakes, and
   * the page reloads — which is another request. Six reloads in ten idle seconds,
   * measured, before these patterns were in place.
   */
  test('the watcher ignores what a running application writes', async () => {
    const { config } = await templatePlugin('serve')

    expect(config.server?.watch?.ignored).toEqual([
      '**/storage/**',
      '**/database/**',
      '**/public/build/**',
      '**/public/hot'
    ])
  })

  /**
   * `base`, which decides every URL no template ever sees.
   *
   * `vite()` in a layout prefixes `/build/` itself when it reads the manifest, so
   * the entry points were always right and this stayed hidden: nothing in the kit
   * used a dynamic `import()`. The first one that did — a Vue island, loaded on
   * demand — asked for `/assets/MemberTable-*.js` and got a 404, while the file
   * sat in `/build/assets/`. Nothing in the build warns about it; the page simply
   * renders without the part that needed JavaScript.
   *
   * The value cannot be constant. In `serve`, `base` is also the path the dev
   * server itself answers under, and the hot-file tags point straight at
   * `http://localhost:5173/resources/...`, so a `/build/` there would 404 every
   * asset in development instead. `laravel-vite-plugin` splits it the same way.
   */
  test('the build carries a base, and the dev server does not', async () => {
    expect((await templatePlugin('build')).config.base).toBe('/build/')
    expect((await templatePlugin('serve')).config.base).toBe('')
  })

  /**
   * Both configs delegate, and neither keeps a copy.
   *
   * Five copies of this logic lived in this repository, 94 to 214 lines each, and
   * the drift between them is where the bugs were: `base` unset in one, a
   * `publicDir` warning in another, a stale hot file in a third. The kit is checked
   * as text because it cannot be imported — it pulls in `@tailwindcss/vite`, which
   * exists only once an application has installed its own dependencies.
   */
  test('the template and the kit both use the package rather than a copy', async () => {
    for (const path of [
      join(templateDir, 'vite.config.ts'),
      resolve(import.meta.dir, '..', 'kits', 'jsx', 'vite.config.ts')
    ]) {
      const config = await Bun.file(path).text()

      expect(config).toContain("from '@elvel/vite'")
      expect(config).toContain('elvel({ input:')

      // The hand-rolled halves, gone: the hot file, the watcher, the prefix.
      expect(config).not.toContain('writeFileSync')
      expect(config).not.toContain('server.hot')
      expect(config).not.toContain('base: command')
    }
  })

  test('dev runs the asset server, and serve stays a plain server', async () => {
    const manifest = (await Bun.file(join(templateDir, '_package.json')).json()) as {
      scripts: Record<string, string>
    }

    expect(manifest.scripts.dev).toBe('bun elvel.ts dev')

    // `--hot` belongs to `dev`, not here: `serve` is what production runs.
    expect(manifest.scripts.serve).toBe('bun elvel.ts serve')
    expect(manifest.scripts.serve).not.toContain('--hot')
  })

  test('dev skips the workers an application does not have', async () => {
    const source = await Bun.file(
      join(root, 'packages', 'console', 'src', 'commands', 'dev.ts')
    ).text()

    // `--kit=none` has neither. Starting them anyway failed with
    // `Command "queue:work" is not defined` and took the server down with it,
    // because the first process to exit stops the rest.
    expect(source).toContain("kernel.has('queue:work')")
    expect(source).toContain("kernel.has('schedule:work')")
    expect(source).toContain("'--hot'")
  })
})

/**
 * The brand, from `art/`.
 *
 * `#FF2D20` is the mark's red and stays exactly that wherever it is a shape. As
 * text on the page's light paper it measures 3.54:1 — enough for a graphic, not
 * enough for small text — so the accents are deliberately darkened and
 * brightened, and these tests are what stops somebody "fixing" them back.
 */
describe('branding', () => {
  test('the favicon is the logo, in the brand red', async () => {
    const favicon = await Bun.file(join(templateDir, 'public', 'favicon.svg')).text()

    expect(favicon).toContain('#FF2D20')
    expect(favicon).toContain('<title>Elvel</title>')
    // The mark itself: an open ring and a bar, as `art/logo.svg` draws them.
    expect(favicon).toContain('stroke-dasharray="63 19"')
  })

  test('the welcome page carries the mark and the measured accents', async () => {
    const page = await Bun.file(
      join(templateDir, 'resources', 'views', 'pages', 'welcome.tsx')
    ).text()

    expect(page).toContain('class="glyph"')
    expect(page).toContain('stroke="currentColor"')

    // 5.32:1 on the light paper, 6.20:1 on the dark. The raw #FF2D20 is 3.54:1
    // and belongs to the logo, not to text.
    expect(page).toContain('--accent: #c9241a')
    expect(page).toContain('--accent: #ff5c50')
    expect(page).not.toContain('#FF2D20')
  })

  test('the art the branding comes from is in the repository', async () => {
    for (const file of ['logo.svg', 'mark.svg']) {
      expect(await Bun.file(join(root, 'art', file)).exists()).toBe(true)
    }

    // `mark.svg` is the colourless one, so a page can put it in `currentColor`.
    const mark = await Bun.file(join(root, 'art', 'mark.svg')).text()

    expect(mark).toContain('currentColor')
    expect(mark).not.toContain('#FF2D20')
  })
})

/**
 * Third-party versions in the template, against what this repository tests with.
 *
 * The framework packages get their range computed — `workspace:*` inside the
 * checkout, `^<installer version>` outside it — but a third-party pin is a
 * literal somebody typed. `better-auth` sat at `1.6.27` while the repository had
 * moved to 1.7.1, which is worse than it sounds: the plugins and responses the
 * auth kits are written against are 1.7's, so a scaffolded application installed
 * a version its own pages did not match, and nothing here noticed.
 */
describe('the versions the template pins', () => {
  test('better-auth matches the one the framework is tested against', async () => {
    const template = (await Bun.file(join(templateDir, '_package.json')).json()) as {
      dependencies: Record<string, string>
    }

    const repository = (await Bun.file(join(root, 'package.json')).json()) as {
      dependencies: Record<string, string>
    }

    const pinned = repository.dependencies['better-auth']

    expect(pinned).toBeDefined()
    expect(template.dependencies['better-auth']).toBe(pinned)
  })
})

/**
 * The `jsx` kit — the auth kit with Tailwind and a component set.
 *
 * It is the first kit built **on** another: `layers: ['auth', 'jsx']`, so it
 * inherits thirty-one files it does not mention and replaces the views it does.
 * Without that it would be a copy of the auth kit, and the two would drift the
 * first time either changed.
 */
/**
 * Every path that signs somebody in has to give them a new session id.
 *
 * Session fixation: an id chosen before signing in is an id somebody else may
 * have chosen, and if it still names the session afterwards then whoever chose it
 * is signed in as this user.
 *
 * This is a test rather than a comment because of how it went wrong. One path was
 * patched — the password one — and the commit said the hole was closed. Three were
 * not: completing a two-factor challenge either way, and registering. The account
 * with two factors on it, the one most worth protecting, was the one left open.
 *
 * The rule is mechanical, so a fifth path — a passkey, a magic link — fails here
 * rather than in somebody's application.
 */
describe('signing in rotates the session', () => {
  test('every controller that lands on the dashboard also regenerates', async () => {
    const authApp = resolve(import.meta.dir, '..', 'kits', 'auth', 'app')
    const behind: string[] = []

    for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: authApp, absolute: true })) {
      const source = await Bun.file(path).text()

      /**
       * The shape that means "this browser is now somebody": a session handed over
       * with `withSession`, and a landing on the application itself.
       */
      const landings = source.match(/redirect\('\/dashboard'\)/g)?.length ?? 0

      if (landings === 0) continue

      const rotations = source.match(/\.regenerate\(/g)?.length ?? 0

      if (rotations < landings) {
        behind.push(`${basename(path)}: ${landings} sign-in, ${rotations} regenerate`)
      }
    }

    expect<string[]>(behind).toEqual([])
  })

  /**
   * And the settings pages do not, which is not an oversight.
   *
   * Changing a profile or turning on two-factor is an operation by somebody
   * already signed in — the identity does not change, so neither should the id.
   */
  test('the settings controllers leave the session alone', async () => {
    const settings = resolve(
      import.meta.dir,
      '..',
      'kits',
      'auth',
      'app',
      'Http',
      'Controllers',
      'Settings'
    )

    for await (const path of new Bun.Glob('*.ts').scan({ cwd: settings, absolute: true })) {
      expect<boolean>((await Bun.file(path).text()).includes('.regenerate(')).toBe(false)
    }
  })
})

describe('the jsx kit', () => {
  const kitDir = resolve(import.meta.dir, '..', 'kits', 'jsx')

  test('it layers on auth rather than copying it', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()

    expect(source).toContain("layers: ['auth', 'jsx']")

    // What it does *not* carry is the point: the models and every controller but
    // one come from the layer underneath.
    const carried = await readdir(kitDir)

    expect(carried).not.toContain('database')
    expect(carried).toContain('resources')

    /**
     * One config file, and only because this kit loads from another origin.
     *
     * Its layout asks `fonts.bunny.net` for a typeface, and a Content Security
     * Policy that does not name that origin blocks it — measured in a browser:
     * `Loading the stylesheet … violates the following Content Security Policy
     * directive: "style-src 'self'"`, with the page rendering in a fallback font
     * and nothing on it saying why. No other kit loads anything off-origin, which
     * is why no other kit needs to say so.
     */
    const configs = await readdir(join(kitDir, 'config'))

    expect<string[]>(configs).toEqual(['security.ts'])

    /**
     * The single exception, and the reason it is one.
     *
     * `Settings/AppearanceController` serves the light/dark/system page, which
     * only means anything to a kit that ships a stylesheet — so it belongs to
     * this layer rather than to the auth kit underneath, which has none.
     */
    const controllers = new Bun.Glob('app/**/*.ts')
    const own: string[] = []

    // `scan` answers with the platform's separator, and this compares with a
    // literal — which passed everywhere except Windows.
    for await (const file of controllers.scan({ cwd: kitDir, onlyFiles: true })) {
      own.push(file.replaceAll('\\', '/'))
    }

    expect<string[]>(own).toEqual(['app/Http/Controllers/Settings/AppearanceController.ts'])
  })

  test('Tailwind arrives as a dev dependency, through the kit manifest', async () => {
    const manifest = (await Bun.file(join(kitDir, 'manifest.json')).json()) as {
      devDependencies: Record<string, string>
    }

    expect(Object.keys(manifest.devDependencies)).toEqual(['@tailwindcss/vite', 'tailwindcss'])

    // `pruneDependencies` deliberately leaves devDependencies alone — it is the
    // toolchain — so a kit needing a build-time dependency has nowhere else.
    const css = await Bun.file(join(kitDir, 'resources', 'css', 'app.css')).text()

    // Quote style is Biome's to decide — it rewrote this to double quotes the
    // moment `css.parser.tailwindDirectives` let it format the file at all.
    expect(css).toMatch(/@import ['"]tailwindcss['"]/)
    expect(await Bun.file(join(kitDir, 'vite.config.ts')).text()).toContain('tailwindcss()')
  })

  test('the base template is untouched by any of it', async () => {
    const manifest = (await Bun.file(join(templateDir, '_package.json')).json()) as {
      devDependencies: Record<string, string>
    }

    // A kit adds itself; it does not change what every other kit gets.
    expect(manifest.devDependencies['tailwindcss']).toBeUndefined()
    expect(await Bun.file(join(templateDir, 'vite.config.ts')).text()).not.toContain('tailwind')
    expect(await Bun.file(join(templateDir, 'resources', 'css', 'app.css')).text()).not.toContain(
      'tailwindcss'
    )
  })

  test('an auth error is shown once, by the field it belongs to', async () => {
    const pages = join(kitDir, 'resources', 'views', 'pages')

    /**
     * Every controller in the auth kit routes an auth failure to a field —
     * `withErrors({ email: … })` — and `Input` reads that bag itself. A page that
     * also rendered an alert for the same string said it twice, which is what a
     * real sign-in attempt showed.
     */
    for (const page of ['auth/sign-in.tsx', 'auth/sign-up.tsx', 'settings/password.tsx']) {
      expect(await Bun.file(join(pages, page)).text()).not.toContain('<Alert message={error}')
    }

    // The two whose errors belong to no field keep theirs.
    for (const page of ['auth/verify-email.tsx', 'settings/security.tsx']) {
      expect(await Bun.file(join(pages, page)).text()).toContain('<Alert message={error}')
    }
  })

  /**
   * Every state-changing form carries a token — checked by rendering one.
   *
   * The kit shipped a sign-out button that returned 419 for as long as it has
   * existed: the form had no `{csrfField()}`, the menu opened, the button
   * submitted, and the middleware rejected it. Nothing rendered wrong, so
   * nothing looked wrong — and the tests around it read the file as a string,
   * where a missing hidden input is exactly as invisible as it is on screen.
   *
   * So this one runs it. `AccountMenu` needs a request scope for the token and
   * nothing else, which is why it is the piece under test.
   */
  test('the sign-out form renders a CSRF token', async () => {
    const { AccountMenu } = await import(
      join(kitDir, 'resources', 'views', 'components', 'app-sidebar.tsx')
    )

    const session = await new Session('probe', new MemorySessionDriver(), 'elvel_session').start()

    const markup = await withRequestScope(
      { request: new Request('http://localhost/dashboard'), session },
      () => AccountMenu({ user: { name: 'Ada Lovelace', email: 'ada@example.test' } })
    )

    expect(markup).toContain('action="/sign-out"')
    expect(markup).toContain('name="_token"')
    expect(markup).toContain(session.token())

    // And the avatar, which is the other thing this component computes.
    expect(markup).toContain('AL')
  })

  /**
   * The same rule, applied to every form in both kits.
   *
   * Rendering each page needs the container; reading each file does not, and a
   * `method="post"` in a file with no `csrfField()` anywhere is wrong however it
   * is arranged. This is the net under the rendered test above.
   */
  test('no view in any kit posts without a token', async () => {
    const offenders: string[] = []
    const kits = resolve(import.meta.dir, '..', 'kits')

    for (const kit of await readdir(kits)) {
      const views = join(kits, kit, 'resources', 'views')

      // `api` answers JSON and ships no views at all.
      if ((await readdir(views).catch(() => undefined)) === undefined) continue

      const glob = new Bun.Glob('**/*.tsx')

      for await (const file of glob.scan({ cwd: views, onlyFiles: true })) {
        const source = await Bun.file(join(views, file)).text()

        if (!source.includes('method="post"')) continue
        if (source.includes('csrfField()')) continue

        offenders.push(`${kit}/${file}`)
      }
    }

    expect<string[]>(offenders).toEqual([])
  })

  test('the field names match the controllers underneath', async () => {
    const password = await Bun.file(
      join(kitDir, 'resources', 'views', 'pages', 'settings', 'password.tsx')
    ).text()

    // `current`, not `current_password`: the controller reads `body.current`, and
    // a form posting the wrong name fails in a way no type checks.
    expect(password).toContain('name="current"')
    expect(password).not.toContain('name="current_password"')
  })
})

/**
 * Inside the checkout is not the same as inside a workspace.
 *
 * `workspace:*` resolves for a directory one of the root manifest's `workspaces`
 * globs matches, and nowhere else. Being anywhere under the checkout was treated
 * as enough, so a scaffold in a scratch directory declared `workspace:*`, was
 * ignored by the root install, got no `node_modules` of its own, and could not
 * install at all — `error: @elvel/view@workspace:* failed to resolve`.
 *
 * The server still started, because module resolution walks up to the root's
 * `node_modules`, so the break only surfaced at `bun run build`, which needs a
 * local `node_modules/.bin`.
 */
describe('workspace mode', () => {
  test('it asks the root manifest which directories are workspaces', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()

    expect(source).toContain('isWorkspaceMember')
    expect(source).toContain('workspaces')

    // `inside` alone is what was wrong; it must now be one condition of two.
    expect(source).toContain('inside && (await isWorkspaceMember(')
  })

  test('the globs it checks against really are the repository', async () => {
    const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
      workspaces: string[]
    }

    // `apps/*` is where the scaffolder tells people to put a local application,
    // so it had better be a workspace.
    expect(manifest.workspaces).toContain('apps/*')

    /**
     * `.demo/*` is one too, and it is a trade rather than an oversight.
     *
     * A scaffold under a workspaces glob links the framework by symlink instead of
     * resolving it from the registry, which is the whole point of scaffolding
     * inside the checkout. The cost is real and was paid once: a workspace member
     * that disappears from `bun.lock` — a reverted lockfile, a branch switch, a
     * stash — is a package `bun install` then *removes*, and it removes the
     * directory, not merely the entry. That is how `apps/demo` was lost.
     *
     * So both globs are listed here on purpose. What must stay true is that every
     * one of them is a directory `.gitignore` keeps out of the repository: a
     * workspace member that could be committed is a different thing entirely.
     */
    expect(manifest.workspaces).toContain('.demo/*')

    const lines = (await Bun.file(join(root, '.gitignore')).text())
      .split('\n')
      .map((line) => line.trim())

    // Compared as whole lines. `includes('packages/')` would have been true of
    // `packages/*/dist` and told us nothing at all.
    for (const [glob, rule] of [
      ['apps/*', 'apps/*'],
      ['.demo/*', '.demo/']
    ] as const) {
      expect<string>(`${glob} ignored by ${rule}: ${lines.includes(rule)}`).toBe(
        `${glob} ignored by ${rule}: true`
      )
    }
  })
})

/**
 * The steps a scaffold prints, and the setup it runs.
 *
 * Both used to compare `kit === 'auth' || kit === 'api'` to decide whether
 * `auth:schema` was needed. Adding a third kit that needs it skipped both in
 * silence: the printed steps said `bun elvel migrate` first, which answers
 * `Nothing to migrate` — the auth tables are generated rather than shipped — and
 * the automatic setup never generated them at all.
 *
 * Asked of the manifest now, so a fourth kit gets it without anybody remembering.
 */
describe('what a scaffold tells you to run', () => {
  test('the decision comes from the dependencies, not the kit name', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()

    expect(source).toContain("dependsOn(target, '@elvel/auth')")
    expect(source).toContain("dependsOn(target, '@elvel/database')")

    // The comparison that caused it must be gone from the code — the only place
    // the old form may still appear is the comment explaining why.
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*'))
      .join('\n')

    expect(code).not.toContain("kit === 'auth'")
  })

  test('auth:schema comes before migrate wherever auth is installed', async () => {
    const source = await Bun.file(resolve(import.meta.dir, '..', 'src', 'index.ts')).text()

    const schema = source.indexOf("dependsOn(target, '@elvel/auth')) ? ['bun elvel auth:schema']")
    const migrate = source.indexOf("dependsOn(target, '@elvel/database')) ? ['bun elvel migrate']")

    expect(schema).toBeGreaterThan(-1)
    expect(migrate).toBeGreaterThan(schema)
  })
})
