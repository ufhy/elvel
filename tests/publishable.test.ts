import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * What has to be true of every package before it is published.
 *
 * Under the framework's old name, `@elyvel/core@0.1.0-alpha.6` went to npm with
 * two dependencies — `dayjs` and `@sinclair/typebox` — and no
 * `@elyvel/contracts`, which its own source imported. `@elyvel/contracts` was
 * never published at all. So the published package could not resolve itself, and
 * nothing in this repository noticed, because a workspace resolves every
 * `@elvel/*` through the root regardless of what any manifest claims. The tests
 * passed. The install did not.
 *
 * That is the shape of every problem here: a manifest is only exercised by
 * somebody else's `bun install`, which is the one place this project never runs.
 * These check the manifests directly instead.
 */

const PACKAGES = join(import.meta.dir, '..', 'packages')

type Manifest = {
  name: string
  version?: string
  description?: string
  keywords?: string[]
  license?: string
  repository?: { directory?: string }
  files?: string[]
  publishConfig?: { access?: string }
  exports?: Record<string, unknown>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

async function packages(): Promise<Array<{ dir: string; manifest: Manifest }>> {
  const entries = await readdir(PACKAGES, { withFileTypes: true })
  const found: Array<{ dir: string; manifest: Manifest }> = []

  for (const entry of entries.filter((one) => one.isDirectory())) {
    found.push({
      dir: entry.name,
      manifest: JSON.parse(
        await readFile(join(PACKAGES, entry.name, 'package.json'), 'utf8')
      ) as Manifest
    })
  }

  return found.sort((a, b) => a.dir.localeCompare(b.dir))
}

/** Template literals and comments hold text that looks like code and is not. */
function strip(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:[^`\\]|\\.)*`/gs, '``')
}

/**
 * `require` counts too.
 *
 * The heavy dependencies are loaded on first use rather than at module scope —
 * `juice` and `nodemailer` in the mailer, `better-auth/adapters` in the auth
 * adapter — and from a synchronous function that means `require`, not `import`.
 * A scanner that only saw `import` called those dependencies unused and told the
 * mailer to drop the inliner it inlines with.
 */
const SPECIFIER =
  /(?:^|[\s;{(])(?:import|export)\s(?:[^'"()]*?\sfrom\s)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]|(?:^|[\s;{(=])require\(\s*['"]([^'"]+)['"]/gm

/** Every package a directory's TypeScript imports, by package name. */
async function imported(directory: string): Promise<Set<string>> {
  const names = new Set<string>()

  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === 'node_modules') continue

      const full = join(path, entry.name)

      if (entry.isDirectory()) {
        await walk(full)
        continue
      }

      if (!/\.tsx?$/.test(entry.name)) continue

      for (const match of strip(await readFile(full, 'utf8')).matchAll(SPECIFIER)) {
        const specifier = (match[1] ?? match[2] ?? match[3]) as string

        if (/^[.]|^node:|^bun:/.test(specifier)) continue

        const parts = specifier.split('/')

        names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string))
      }
    }
  }

  await walk(directory)

  return names
}

describe('every package is publishable', () => {
  test('and they all carry the same version', async () => {
    const versions = new Set((await packages()).map((one) => one.manifest.version))

    // One number for all of them, as Laravel keeps `illuminate/*` in lockstep.
    // Mixed versions were how this got to 19 packages on 0.0.1 and 8 on 0.1.0
    // while npm held 0.1.0-alpha.6 under the old name.
    expect<number>(versions.size).toBe(1)
  })

  test('with the metadata an npm page is made of', async () => {
    const incomplete: string[] = []

    for (const { dir, manifest } of await packages()) {
      const missing: string[] = []

      /**
       * `private` stops a publish dead, and eight packages carried it.
       *
       * It is how six of the eleven packages that were never published under the
       * old scope came to be missing — `npm publish` answers `EPRIVATE` and
       * refuses, and nothing else in a monorepo ever asks. The root manifest
       * keeps the flag on purpose; a package inside `packages/` must not.
       */
      if ((manifest as { private?: boolean }).private) missing.push('private: true')

      if (!manifest.description) missing.push('description')
      if (!manifest.keywords?.length) missing.push('keywords')
      if (manifest.license !== 'MIT') missing.push('license')
      if (manifest.repository?.directory !== `packages/${dir}`) missing.push('repository.directory')
      if (!manifest.files?.length) missing.push('files')

      // A scoped package is private by default, and `npm publish` fails on it
      // with a 402 that reads like a billing problem.
      if (manifest.publishConfig?.access !== 'public') missing.push('publishConfig.access')

      if (missing.length > 0) incomplete.push(`${manifest.name}: ${missing.join(', ')}`)
    }

    expect<string[]>(incomplete).toEqual([])
  })

  /**
   * The alpha.6 bug, as a test.
   *
   * Anything `src/` or `config/` imports has to be a real dependency, because a
   * consumer's install is what resolves it — and a workspace will happily hide a
   * missing one for as long as the code never leaves this repository.
   */
  test('and depend on everything their shipped code imports', async () => {
    const missing: string[] = []

    for (const { dir, manifest } of await packages()) {
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        'bun'
      ])

      const used = new Set([
        ...(await imported(join(PACKAGES, dir, 'src'))),
        ...(await imported(join(PACKAGES, dir, 'config')))
      ])

      for (const name of [...used].sort()) {
        if (!declared.has(name)) missing.push(`${manifest.name} imports ${name}`)
      }
    }

    expect<string[]>(missing).toEqual([])
  })

  /**
   * And the other direction, which costs an installer rather than breaking it.
   *
   * A dependency nothing imports is a package every consumer downloads for
   * nothing — `@elvel/contracts` was declared by nine packages that never
   * imported it, and `dayjs` was in the old published core manifest while no
   * source file mentioned it. A test-only import belongs in `devDependencies`.
   */
  test('and nothing they do not', async () => {
    const spare: string[] = []

    for (const { dir, manifest } of await packages()) {
      const used = new Set([
        ...(await imported(join(PACKAGES, dir, 'src'))),
        ...(await imported(join(PACKAGES, dir, 'config')))
      ])

      for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
        /**
         * A `@types/*` package is used by the compiler, not by an import.
         *
         * And it has to be a real dependency rather than a development one,
         * because these packages ship TypeScript source: a consumer's `tsc`
         * compiles our internals, so whatever our source needs to typecheck must
         * reach them too. `@elvel/mail` imports
         * `nodemailer/lib/smtp-transport`, and with `@types/nodemailer` sitting in
         * the repository root as a devDependency, our own typecheck passed while a
         * freshly scaffolded application that installed the mailer failed on
         * `Try \`npm i --save-dev @types/nodemailer\``.
         */
        if (name.startsWith('@types/')) continue

        if (!used.has(name)) spare.push(`${manifest.name} depends on unused ${name}`)
      }
    }

    expect<string[]>(spare).toEqual([])
  })

  /**
   * `files` decides the tarball, and the default is "everything".
   *
   * Without it a package ships its own `test/` directory, and anything a build
   * or a probe left in the folder. What each one ships is its source plus the
   * directories the framework reads at run time.
   */
  /**
   * A package Node reads has to ship what Node can read.
   *
   * Every package here ships TypeScript source, because Bun is what consumes
   * them — except `@elvel/vite`, which Vite's config loader imports from a Node
   * process. Vite's binary is `#!/usr/bin/env node` and its config bundler
   * externalises every bare import it can resolve, so Node ends up doing
   * `import('…/src/index.ts')` and answers `ERR_UNKNOWN_FILE_EXTENSION`.
   *
   * Measured on a machine with Node on `PATH`: `vite build`, `bun x vite build`
   * and `bun x vite` all failed. CI never saw it, because its image has no `node`
   * binary and Bun ran the shim instead.
   *
   * So: a package whose exports name `dist` must declare the build that writes
   * it, and must ship it. The next one to need this fails here rather than in
   * somebody's application.
   */
  test('a package that exports dist declares the build that writes it', async () => {
    const wrong: string[] = []

    for (const { manifest } of await packages()) {
      const exports = JSON.stringify(manifest.exports ?? {})

      if (!exports.includes('dist/')) continue

      if (manifest.scripts?.build === undefined) wrong.push(`${manifest.name}: no build script`)
      if (!(manifest.files ?? []).includes('dist')) wrong.push(`${manifest.name}: dist not shipped`)

      /**
       * And Bun still reads the source.
       *
       * Without that condition the repository's own tests, and every Bun consumer,
       * would run whatever `dist` last happened to contain — which is how a build
       * artifact goes stale without anybody noticing.
       */
      if (!exports.includes('"bun":')) wrong.push(`${manifest.name}: no bun condition`)
    }

    expect<string[]>(wrong).toEqual([])
  })

  test('and ship source rather than tests', async () => {
    const wrong: string[] = []

    for (const { dir, manifest } of await packages()) {
      const files = manifest.files ?? []

      if (!files.includes('src')) wrong.push(`${manifest.name}: no src`)
      if (files.includes('test')) wrong.push(`${manifest.name}: ships test`)

      for (const runtime of ['config', 'stubs']) {
        const present = await readdir(join(PACKAGES, dir, runtime))
          .then(() => true)
          .catch(() => false)

        if (present && !files.includes(runtime)) wrong.push(`${manifest.name}: no ${runtime}`)
      }
    }

    expect<string[]>(wrong).toEqual([])
  })
})
