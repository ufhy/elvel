#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import * as prompts from '@clack/prompts'
import pc from 'picocolors'

/**
 * Scaffold an application skeleton.
 *
 * From this repository:            bun run create apps/blog
 * Once published to npm:           bun create elysian my-app
 *
 * `bun create <name>` resolves only three ways — `bunx create-<name>` from npm,
 * a GitHub repo, or a template folder in `$HOME/.bun-create` / `./.bun-create`.
 * A workspace package is not one of them, so the short form needs a publish.
 */

const TEMPLATE_DIR = resolve(import.meta.dir, '..', 'template')
const KITS_DIR = resolve(import.meta.dir, '..', 'kits')

/**
 * What a starter kit adds on top of the base template.
 *
 * A kit is a folder copied over the template, not a fork of it: everything a
 * kit does not mention it inherits, so the base and the kits cannot drift the
 * way two full templates would. Laravel's Breeze installs into an existing
 * application for the same reason.
 */
const KITS: Record<string, { label: string; describe: string; routes: string[] }> = {
  none: { label: 'None — a landing page', describe: '', routes: [] },
  auth: {
    label: 'Auth — sign in, sign up, a dashboard',
    describe: 'server-rendered auth pages over better-auth',
    routes: ['  .use(AuthPageController)']
  }
}

/** Files renamed on copy, so they don't affect the template's own tooling. */
const RENAMES: Record<string, string> = {
  '_package.json': 'package.json',
  '_env.example': '.env.example',
  _gitignore: '.gitignore'
}

/** Substitution runs on these extensions only, never on binaries or CSS. */
const SUBSTITUTABLE = new Set(['.json', '.ts', '.md', '.example', '.txt', ''])

type Replacements = Record<string, string>

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2)
  const force = argv.includes('--force')
  const positional = argv.filter((token) => !token.startsWith('-'))
  const requestedKit = argv.find((token) => token.startsWith('--kit='))?.slice('--kit='.length)
  const minimal = argv.includes('--minimal')

  prompts.intro(pc.bgCyan(pc.black(' create-elysian ')))

  let name = positional[0]

  if (name === undefined) {
    const answer = await prompts.text({
      message: 'Project name',
      placeholder: 'my-app',
      defaultValue: 'my-app'
    })
    if (prompts.isCancel(answer)) {
      prompts.cancel('Aborted.')
      return 130
    }
    name = answer || 'my-app'
  }

  let kit = requestedKit ?? (minimal ? 'none' : undefined)

  if (kit !== undefined && !(kit in KITS)) {
    prompts.cancel(`Unknown kit "${kit}". Available: ${Object.keys(KITS).join(', ')}.`)

    return 1
  }

  const target = resolve(process.cwd(), name)

  if (!force && (await exists(target)) && (await readdir(target)).length > 0) {
    prompts.cancel(`Directory "${relative(process.cwd(), target) || '.'}" is not empty.`)
    return 1
  }

  if (kit === undefined) {
    const chosen = await prompts.select({
      message: 'Starter kit',
      options: Object.entries(KITS).map(([value, entry]) => ({ value, label: entry.label })),
      initialValue: 'none'
    })

    if (prompts.isCancel(chosen)) {
      prompts.cancel('Aborted.')

      return 130
    }

    kit = chosen as string
  }

  const monorepoRoot = await findMonorepoRoot()

  /**
   * Inside the framework checkout the app becomes a workspace member, so Bun
   * links `packages/*` by symlink. Outside it, the app installs the published
   * packages. There is deliberately no `file:` middle ground: Bun hardlinks
   * `file:` dependencies into its store, so an editor that writes by replacing
   * a file silently detaches the copy and the app keeps running stale code.
   */
  const workspaceMode = monorepoRoot !== undefined && target.startsWith(`${monorepoRoot}/`)

  if (monorepoRoot !== undefined && !workspaceMode) {
    prompts.log.warn(
      `Target is outside the framework checkout, so the published packages will be required.\n` +
        `For local development scaffold inside it, e.g. ${pc.cyan(`apps/${name}`)}.`
    )
  }

  const spinner = prompts.spinner()
  spinner.start('Creating project')

  const replacements: Replacements = {
    name: name.replace(/^.*\//, ''),
    ...frameworkDependencies(workspaceMode)
  }

  let written = await copyTemplate(TEMPLATE_DIR, target, replacements)

  if (kit !== 'none') {
    // Copied over the template, so a kit only carries what it changes.
    written += await copyTemplate(join(KITS_DIR, kit as string), target, replacements)
    await registerKitRoutes(target, KITS[kit as string]?.routes ?? [])
  }

  // Ship a working .env, not just the example — with its secrets filled in.
  const exampleEnv = Bun.file(join(target, '.env.example'))
  if (await exampleEnv.exists()) {
    await Bun.write(join(target, '.env'), withSecrets(await exampleEnv.text()))
  }

  spinner.stop(`Created ${written} files`)

  /**
   * The auth tables are a step; the secrets are not.
   *
   * Both secrets are written above, because generating one is not a decision
   * anybody needs to make and the alternative was worse than it looked: the
   * template used to ship a placeholder `APP_KEY`, `key:generate` counted that as
   * "already set" and refused, and the application ran on a key published in this
   * repository. The first command in these steps failed, every time.
   *
   * better-auth's tables stay a step, because they are whatever `config/auth.ts`
   * asks for and the generator has to read it. Without the migration the first
   * sign-up answers 500, which is a poor way to learn about it.
   */
  const start = ['bun artisan auth:schema', 'bun artisan migrate', 'bun run dev']

  const steps = workspaceMode
    ? [
        // Workspace members must be installed from the repository root.
        `cd ${relative(process.cwd(), monorepoRoot as string) || '.'} && bun install`,
        `cd ${relative(monorepoRoot as string, target)}`,
        ...start
      ]
    : [`cd ${relative(process.cwd(), target) || '.'}`, 'bun install', ...start]

  prompts.note(steps.join('\n'), 'Next steps')

  if (workspaceMode) {
    prompts.log.info('Created as a workspace member — framework packages link by symlink.')
  }

  prompts.outro(`Then open ${pc.underline('http://localhost:3000')}`)
  return 0
}

/**
 * Fill in the secrets the template deliberately leaves empty.
 *
 * Written here rather than by shelling out to `artisan key:generate`, which
 * cannot run yet: in workspace mode the framework packages are not linked until
 * `bun install` runs at the repository root, so artisan would fail on its first
 * import. `node:crypto` needs nothing.
 *
 * `APP_KEY` is 32 random bytes as base64url, matching what `generateKey()`
 * writes; `AUTH_SECRET` is 32 bytes of hex, which is what better-auth documents.
 * They are separate values on purpose.
 */
function withSecrets(env: string): string {
  const key = randomBytes(32).toString('base64url')
  const secret = randomBytes(32).toString('hex')

  return env
    .replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`)
    .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`)
}

/**
 * Every framework package the template depends on.
 *
 * Hand-maintained, and therefore the thing that drifts: `broadcasting` and
 * `translation` were both built and both missing from here, which a scaffolded
 * application only discovers when it tries to resolve a provider that was never
 * installed. `create-elysian.test.ts` holds this list to the contents of
 * `packages/`, so the next one fails a test instead of a user.
 */
const FRAMEWORK_PACKAGES = [
  'auth',
  'broadcasting',
  'cache',
  'concurrency',
  'console',
  'contracts',
  'core',
  'database',
  'encryption',
  'events',
  'hashing',
  'http',
  'http-client',
  'image',
  'log',
  'mail',
  'notifications',
  'process',
  'queue',
  'scheduler',
  'storage',
  'support',
  'testing',
  'translation',
  'validation',
  'view'
] as const

/** Locate the framework checkout root, if we are scaffolding from inside one. */
async function findMonorepoRoot(): Promise<string | undefined> {
  let directory = import.meta.dir

  while (true) {
    const manifest = Bun.file(join(directory, 'package.json'))

    if (await manifest.exists()) {
      const parsed = (await manifest.json()) as { name?: string; workspaces?: unknown }
      if (parsed.name === 'elysian' && parsed.workspaces !== undefined) return directory
    }

    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function frameworkDependencies(workspaceMode: boolean): Replacements {
  const entries = FRAMEWORK_PACKAGES.map((name) => [
    `dep_${name}`,
    workspaceMode ? 'workspace:*' : '^0.0.1'
  ])

  return Object.fromEntries(entries) as Replacements
}

async function copyTemplate(
  source: string,
  target: string,
  replacements: Replacements
): Promise<number> {
  await mkdir(target, { recursive: true })

  let count = 0

  for (const entry of await readdir(source)) {
    const from = join(source, entry)
    const to = join(target, RENAMES[entry] ?? entry)

    const info = await stat(from)

    if (info.isDirectory()) {
      count += await copyTemplate(from, to, replacements)
      continue
    }

    const file = Bun.file(from)
    const extension = entry.includes('.') ? `.${entry.split('.').pop()}` : ''

    if (SUBSTITUTABLE.has(extension)) {
      const contents = await file.text()
      await Bun.write(to, substitute(contents, replacements))
    } else {
      await Bun.write(to, file)
    }

    count += 1
  }

  return count
}

function substitute(contents: string, replacements: Replacements): string {
  return contents.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const value = replacements[key]
    return value === undefined ? match : value
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

process.exit(await main())

/**
 * Mount a kit's controllers in `routes/web.ts`.
 *
 * Rewritten rather than shipped as part of the kit: the routes file is the one
 * place the base template and every kit both need to touch, and a kit that
 * replaced it wholesale would silently drop anything the base had added.
 */
async function registerKitRoutes(target: string, routes: string[]): Promise<void> {
  if (routes.length === 0) return

  const path = join(target, 'routes', 'web.ts')
  const source = await Bun.file(path).text()

  const imports = routes
    .map((line) =>
      line
        .trim()
        .replace(/^\.use\(/, '')
        .replace(/\)$/, '')
    )
    .map((name) => `import ${name} from '../app/Http/Controllers/${name}.ts'`)
    .join('\n')

  const mounted = source
    .replace(
      "import PageController from '../app/Http/Controllers/PageController.ts'",
      `import PageController from '../app/Http/Controllers/PageController.ts'\n${imports}`
    )
    .replace(
      "export default new Elysia({ name: 'routes:web' }).use(PageController)",
      `export default new Elysia({ name: 'routes:web' })\n  .use(PageController)\n${routes.join('\n')}`
    )

  await Bun.write(path, `${mounted.trimEnd()}\n`)
}
