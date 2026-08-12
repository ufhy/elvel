#!/usr/bin/env bun
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

  const target = resolve(process.cwd(), name)

  if (!force && (await exists(target)) && (await readdir(target)).length > 0) {
    prompts.cancel(`Directory "${relative(process.cwd(), target) || '.'}" is not empty.`)
    return 1
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

  const written = await copyTemplate(TEMPLATE_DIR, target, replacements)

  // Ship a working .env, not just the example.
  const exampleEnv = Bun.file(join(target, '.env.example'))
  if (await exampleEnv.exists()) {
    await Bun.write(join(target, '.env'), await exampleEnv.text())
  }

  spinner.stop(`Created ${written} files`)

  const steps = workspaceMode
    ? [
        // Workspace members must be installed from the repository root.
        `cd ${relative(process.cwd(), monorepoRoot as string) || '.'} && bun install`,
        `cd ${relative(monorepoRoot as string, target)}`,
        'bun run dev'
      ]
    : [`cd ${relative(process.cwd(), target) || '.'}`, 'bun install', 'bun run dev']

  prompts.note(steps.join('\n'), 'Next steps')

  if (workspaceMode) {
    prompts.log.info('Created as a workspace member — framework packages link by symlink.')
  }

  prompts.outro(`Then open ${pc.underline('http://localhost:3000')}`)
  return 0
}

const FRAMEWORK_PACKAGES = [
  'console',
  'contracts',
  'core',
  'database',
  'events',
  'log',
  'support',
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
