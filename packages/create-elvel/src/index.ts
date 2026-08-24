#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as prompts from '@clack/prompts'
import pc from 'picocolors'

/**
 * Scaffold an application skeleton.
 *
 * From this repository:            bun run create apps/blog
 * Once published to npm:           bun create elvel my-app
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
/**
 * A kit's `layers` are the folders copied over the template, in order.
 *
 * Most kits are one folder. `jsx` is two — `auth` and then its own — because it
 * *is* the auth kit with a different front end, and duplicating thirty-one files
 * to say so would guarantee the two drift. The later layer wins per file, so a
 * page it ships replaces the one underneath and everything it does not mention
 * it inherits.
 */
const KITS: Record<
  string,
  { label: string; describe: string; routes: string[]; layers?: string[] }
> = {
  none: { label: 'None — a landing page', describe: '', routes: [] },
  auth: {
    label: 'Auth — sign in, sign up, a dashboard',
    describe: 'server-rendered auth pages over better-auth',
    /**
     * Five controllers rather than one, split by what a page is *for*.
     *
     * They were one file of 619 lines and nineteen routes — everything from the
     * sign-in form to closing an account. Laravel's own kit has no such file:
     * Fortify holds the auth logic, each page is its own component, and the
     * settings routes live apart in `routes/settings.php`.
     */
    routes: [
      '  .use(Auth/ConfirmPasswordController)',
      '  .use(Auth/PasswordResetController)',
      '  .use(Auth/RegisterController)',
      '  .use(Auth/SignInController)',
      '  .use(Auth/TwoFactorChallengeController)',
      '  .use(Auth/VerifyEmailController)',
      '  .use(DashboardController)',
      '  .use(Settings/PasskeyController)',
      '  .use(Settings/PasswordController)',
      '  .use(Settings/ProfileController)',
      '  .use(Settings/SecurityController)',
      '  .use(Settings/TwoFactorController)'
    ]
  },
  jsx: {
    label: 'JSX — the auth kit, with Tailwind and a component set',
    describe: 'server-rendered JSX styled with Tailwind, over better-auth',
    /**
     * The auth kit's routes, because this *is* the auth kit with a different
     * front end. Listed rather than derived: `registerKitRoutes` writes them into
     * `routes/web.ts`, and a layer that inherited a controller still has to
     * mount it.
     */
    routes: [
      '  .use(Auth/ConfirmPasswordController)',
      '  .use(Auth/PasswordResetController)',
      '  .use(Auth/RegisterController)',
      '  .use(Auth/SignInController)',
      '  .use(Auth/TwoFactorChallengeController)',
      '  .use(Auth/VerifyEmailController)',
      '  .use(DashboardController)',
      // This kit's own, and the only route the auth kit has no use for: a theme
      // is a Tailwind concern, and the auth kit ships no stylesheet to theme.
      '  .use(Settings/AppearanceController)',
      '  .use(Settings/PasskeyController)',
      '  .use(Settings/PasswordController)',
      '  .use(Settings/ProfileController)',
      '  .use(Settings/SecurityController)',
      '  .use(Settings/TwoFactorController)'
    ],
    layers: ['auth', 'jsx']
  },

  vue: {
    label: 'Vue — the auth kit, with a Vite + Vue client',
    describe: 'server-rendered auth over better-auth, and a Vue SPA behind it',
    /**
     * The auth kit's routes, plus one of this kit's own — mounted last.
     *
     * `AuthPageController` takes over the seven auth **pages** and nothing else:
     * every action stays with the controllers above it, unedited and uncopied. It
     * comes last because in Elysia the last registration of a path wins, which is
     * the whole mechanism. Moving it up this list silently gives the pages back.
     *
     * `DashboardController` is replaced rather than shadowed — that one is this
     * kit's file already.
     */
    routes: [
      '  .use(Auth/ConfirmPasswordController)',
      '  .use(Auth/PasswordResetController)',
      '  .use(Auth/RegisterController)',
      '  .use(Auth/SignInController)',
      '  .use(Auth/TwoFactorChallengeController)',
      '  .use(Auth/VerifyEmailController)',
      '  .use(DashboardController)',
      '  .use(Settings/PasskeyController)',
      '  .use(Settings/PasswordController)',
      '  .use(Settings/ProfileController)',
      '  .use(Settings/SecurityController)',
      '  .use(Settings/TwoFactorController)',
      '  .use(Auth/AuthPageController)'
    ],
    layers: ['auth', 'vue']
  },

  api: {
    label: 'API — token auth, JSON, no views',
    describe: 'bearer-token auth over better-auth, answering JSON',
    routes: ['  .use(ApiAuthController)']
  }
}

/** Files renamed on copy, so they don't affect the template's own tooling. */
const RENAMES: Record<string, string> = {
  '_package.json': 'package.json',
  '_env.example': '.env.example',
  _gitignore: '.gitignore',
  /**
   * The shipped tests, which are real tests once they are somewhere real.
   *
   * They import `../bootstrap/app.ts`, which only exists in a scaffolded
   * application — so under their real name this repository's own `bun test`
   * would find them, boot nothing, and fail. The name they are stored under has
   * no `.test.` in it, which is what keeps them out of that net; the underscore
   * says the same thing to a reader, as it does for `package.json`.
   */
  _editorconfig: '.editorconfig',
  _gitattributes: '.gitattributes',
  '_example.ts': 'example.test.ts',
  '_api.ts': 'api.test.ts',
  '_authentication.ts': 'authentication.test.ts',
  '_registration.ts': 'registration.test.ts',
  '_two-factor.ts': 'two-factor.test.ts',
  '_passkeys.ts': 'passkeys.test.ts',
  '_profile.ts': 'profile.test.ts'
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

  /**
   * Whether to install and set up the database, rather than print the steps.
   *
   * Explicit flags win; otherwise it is asked, and the answer defaults to yes.
   * A script that passes `--kit=` and no answer gets the printed steps, because
   * running `bun install` in somebody's CI without being asked is not a default
   * a scaffolder gets to choose.
   */
  const setUp = argv.includes('--install')
    ? true
    : argv.includes('--no-install')
      ? false
      : undefined

  prompts.intro(pc.bgCyan(pc.black(' create-elvel ')))

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
  /**
   * Is the target inside the framework checkout?
   *
   * Compared through `relative()` rather than by string prefix: the prefix form
   * hardcoded `/`, so on Windows — where the same paths are `D:\a\elvel\elvel`
   * — it was never true, and a scaffold created inside the checkout quietly asked
   * npm for the published packages instead of linking the ones being edited.
   */
  const inside = (() => {
    if (monorepoRoot === undefined) return false

    const step = relative(monorepoRoot, target)

    return step !== '' && !step.startsWith('..') && !isAbsolute(step)
  })()

  /**
   * Inside the checkout is not the same as inside a **workspace**.
   *
   * `workspace:*` only resolves for a directory one of the root manifest's
   * `workspaces` globs matches. Being anywhere under the checkout was treated as
   * enough, so a scaffold in a scratch directory like `.demo/` declared
   * `workspace:*`, was ignored by the root install, got no `node_modules` of its
   * own, and could not run `bun install` at all:
   *
   *     error: @elvel/view@workspace:* failed to resolve
   *
   * The server still started, because module resolution walks up to the root's
   * `node_modules` — so the break only showed up at `bun run build`, which needs
   * a local `node_modules/.bin`. Checked properly now, and said out loud when it
   * is not true.
   */
  const workspaceMode = inside && (await isWorkspaceMember(monorepoRoot as string, target))

  if (monorepoRoot !== undefined && !workspaceMode) {
    prompts.log.warn(
      inside
        ? `Inside the checkout, but not one of its workspaces — so the published packages will be required.\n` +
            `To link the packages being edited, scaffold under one, e.g. ${pc.cyan(`apps/${basename(target)}`)}.`
        : `Target is outside the framework checkout, so the published packages will be required.\n` +
            `For local development scaffold inside it, e.g. ${pc.cyan(`apps/${name}`)}.`
    )
  }

  const spinner = prompts.spinner()
  spinner.start('Creating project')

  const replacements: Replacements = {
    /**
     * The last path segment, whatever the separator.
     *
     * This was `name.replace(/^.*\//, '')`, which cuts at the last forward
     * slash — so on Windows it cut nothing, and an absolute target put
     * `D:\a\elvel\...` into `"name"` in `package.json`. `\a` is not a JSON
     * escape, so the manifest the scaffolder had just written would not parse,
     * and the scaffolder died reading its own output.
     */
    name: basename(target),
    ...(await frameworkDependencies(workspaceMode))
  }

  let written = await copyTemplate(TEMPLATE_DIR, target, replacements)

  if (kit !== 'none') {
    const entry = KITS[kit as string]

    // Copied over the template, so a kit only carries what it changes — and a
    // kit built on another copies that one first.
    for (const layer of entry?.layers ?? [kit as string]) {
      written += await copyTemplate(join(KITS_DIR, layer), target, replacements)

      // After its own copy, so a layer can drop what the layers under it left
      // behind without having to avoid naming its own files.
      written -= await applyLayerRemovals(layer, target)
    }

    await registerKitRoutes(target, entry?.routes ?? [])
    written += (await mergeKitManifest(target, entry?.layers ?? [kit as string])) ? 1 : 0
  }

  await adoptClientProject(target)

  await pruneConfig(target, await pruneDependencies(target))

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
  // Workspace members must be installed from the repository root; a standalone
  // app installs in its own directory.
  const installRoot = workspaceMode ? (monorepoRoot as string) : target

  const wanted =
    setUp ?? (requestedKit === undefined && positional.length === 0 ? await confirmSetUp() : false)

  if (wanted && (await setUpProject(installRoot, target))) {
    if (workspaceMode) {
      prompts.log.info('Created as a workspace member — framework packages link by symlink.')
    }

    prompts.note('bun run dev', 'Next step')
    prompts.outro(`Then open ${pc.underline('http://localhost:3000')}`)

    return 0
  }

  const start = [
    ...((await dependsOn(target, '@elvel/auth')) ? ['bun elvel auth:schema'] : []),
    ...((await dependsOn(target, '@elvel/database')) ? ['bun elvel migrate'] : []),
    // Once, so the manifest exists and the pages carry their assets. While
    // working on them, `bun run dev:assets` in a second terminal is the
    // hot-reloading version.
    ...(kit === 'api' ? [] : ['bun run build']),
    'bun run dev'
  ]

  const steps = workspaceMode
    ? [
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

/** Ask, defaulting to yes. A cancel is a no rather than an abort. */
async function confirmSetUp(): Promise<boolean> {
  const answer = await prompts.confirm({
    message: 'Install dependencies and set up the database?',
    initialValue: true
  })

  return !prompts.isCancel(answer) && answer
}

/**
 * Run the steps this used to print — install, auth tables, migrate.
 *
 * Returns false rather than throwing when anything fails, so the caller falls
 * back to printing the steps. A scaffolder that leaves somebody with a
 * half-installed directory and a stack trace is worse than one that hands over a
 * list of three commands.
 *
 * `auth:schema` only for the auth kit: without better-auth in the application it
 * is not registered, and running it would report an unknown command as though
 * something had gone wrong.
 */
async function setUpProject(installRoot: string, target: string): Promise<boolean> {
  const spinner = prompts.spinner()

  const run = async (label: string, cwd: string, argv: string[]): Promise<boolean> => {
    spinner.start(label)

    const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
    const code = await child.exited

    if (code !== 0) {
      spinner.stop(`${label} failed`)
      // The tail only: a full install log buries the one line that matters.
      prompts.log.error((await new Response(child.stderr).text()).trim().slice(-500))

      return false
    }

    spinner.stop(label)

    return true
  }

  if (!(await run('Installing dependencies', installRoot, ['bun', 'install']))) return false

  /**
   * Any kit with auth needs better-auth's tables, and none of them ship a
   * migration for them: what the tables are depends on the options and plugins in
   * `config/auth.ts`, so they are generated.
   *
   * Asked of the manifest rather than of the kit's name — the two kits this used
   * to name by hand became three, and the third was skipped in silence.
   */
  if (await dependsOn(target, '@elvel/auth')) {
    if (!(await run('Writing the auth tables', target, ['bun', 'elvel.ts', 'auth:schema']))) {
      return false
    }
  }

  /**
   * Only when the application has a database at all.
   *
   * `--kit=none` prunes `@elvel/database`, so `migrate` is not registered, and
   * running it printed `Command "migrate" is not defined` under a step called
   * "Migrating failed" — the scaffolder reporting its own success as a failure,
   * on the very first thing a new application does. Exactly the trap the
   * `auth:schema` guard above exists to avoid; this line was missing it.
   *
   * Decided from the manifest rather than from the kit's name, so a kit added
   * later is covered without anybody remembering to come back here.
   */
  const manifest = (await Bun.file(join(target, 'package.json')).json()) as {
    dependencies?: Record<string, string>
  }

  if (manifest.dependencies?.['@elvel/database'] === undefined) return true

  return await run('Migrating', target, ['bun', 'elvel.ts', 'migrate', '--force'])
}

/**
 * Fill in the secrets the template deliberately leaves empty.
 *
 * Written here rather than by shelling out to `elvel key:generate`, which
 * cannot run yet: in workspace mode the framework packages are not linked until
 * `bun install` runs at the repository root, so elvel would fail on its first
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
 * installed. `create-elvel.test.ts` holds this list to the contents of
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
  'spa',
  'storage',
  'support',
  'testing',
  'translation',
  'validation',
  'view',
  'vite'
] as const

/**
 * Read a JSON file, and say which one when it will not parse.
 *
 * Bun's own message is `SyntaxError: Failed to parse JSON` and nothing else —
 * no path, no offending text. A Windows CI run failed on that line for a
 * fortnight saying only that, while three JSON files were candidates.
 */
async function readJson<T>(path: string): Promise<T> {
  const text = await Bun.file(path).text()

  try {
    return JSON.parse(text) as T
  } catch (problem) {
    throw new Error(
      `${path} is not valid JSON (${problem instanceof Error ? problem.message : problem}): ` +
        `${text.slice(0, 200)}`
    )
  }
}

/** Locate the framework checkout root, if we are scaffolding from inside one. */
async function findMonorepoRoot(): Promise<string | undefined> {
  let directory = import.meta.dir

  while (true) {
    const manifest = Bun.file(join(directory, 'package.json'))

    if (await manifest.exists()) {
      const parsed = await readJson<{ name?: string; workspaces?: unknown }>(
        join(directory, 'package.json')
      )
      if (parsed.name === 'elvel' && parsed.workspaces !== undefined) return directory
    }

    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * The version a scaffolded application asks for, outside this repository.
 *
 * This installer's own version, because every package is released in lockstep
 * with it — `create-elvel@1.0.0-alpha.1` belongs with `@elvel/core@1.0.0-alpha.1`
 * and nothing else. It used to be the literal `^0.0.1`, which no published
 * package has ever carried: `bunx create-elvel` scaffolded an application whose
 * `bun install` could not resolve a single framework package, and the failure
 * arrived as a wall of 404s with no hint that the scaffolder had written a
 * version out of thin air.
 *
 * Read from disk rather than compiled in, so a release cannot forget it.
 */
async function installerVersion(): Promise<string> {
  const manifest = await readJson<{ version?: string }>(
    resolve(import.meta.dir, '..', 'package.json')
  )

  return manifest.version ?? '*'
}

async function frameworkDependencies(workspaceMode: boolean): Promise<Replacements> {
  const range = workspaceMode ? 'workspace:*' : `^${await installerVersion()}`
  const entries = FRAMEWORK_PACKAGES.map((name) => [`dep_${name}`, range])

  return Object.fromEntries(entries) as Replacements
}

/**
 * Files a layer deletes, named in its `manifest.json` as `removes`.
 *
 * Layering is additive, and that is usually the point — a kit carries only what it
 * changes. But a kit can also be *smaller* than what it builds on: the Vue kit
 * renders its auth screens in the client, so the `auth` layer's `.tsx` pages
 * underneath it are files nobody chose, one of which is never even rendered.
 * Shipping them is not harmless — a developer opens `resources/views/pages/auth/`,
 * edits a page, and nothing changes on screen.
 *
 * Only `removes` deletes anything, and only inside the target. A layer is repo
 * content rather than user input, but a path that climbs out of the target would
 * delete somebody's files, and a guard is cheaper than being sure forever.
 */
async function applyLayerRemovals(layer: string, target: string): Promise<number> {
  const file = Bun.file(join(KITS_DIR, layer, 'manifest.json'))

  if (!(await file.exists())) return 0

  const { removes } = (await file.json()) as { removes?: string[] }

  let removed = 0

  for (const path of removes ?? []) {
    const full = join(target, path)

    if (isAbsolute(path) || relative(target, full).startsWith('..')) {
      throw new Error(`Kit layer "${layer}" tried to remove "${path}", which is outside the app.`)
    }

    if (!(await Bun.file(full).exists()) && !(await directoryExists(full))) continue

    await rm(full, { recursive: true, force: true })
    removed += 1

    // The Vue kit removes all seven pages under `resources/views/pages/auth`, and
    // an empty directory left behind is a place a developer looks for something
    // that is not there any more.
    await pruneEmptyParents(dirname(full), target)
  }

  return removed
}

/** Walk up removing directories that the removal emptied, stopping at the app. */
async function pruneEmptyParents(directory: string, target: string): Promise<void> {
  let at = directory

  while (at !== target && relative(target, at) !== '' && !relative(target, at).startsWith('..')) {
    if ((await readdir(at)).length > 0) return

    // `recursive`, because `rm` refuses a directory without it — even an empty one,
    // which the line above has just established this is. `ERR_FS_EISDIR`.
    await rm(at, { recursive: true, force: true })
    at = dirname(at)
  }
}

/** `Bun.file().exists()` answers false for a directory, which is not the question. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
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

/**
 * Dependencies a scaffolded application never mentions, and always needs.
 *
 * `elysia` is the server the framework is built on and reaches the application
 * through `@elvel/http`, not through an import of its own. `@kitajs/html` is
 * the JSX runtime `tsconfig.json` names in `jsxImportSource`, which is a
 * reference no import scan can see.
 */
const ALWAYS_DEPENDED_ON = new Set(['elysia', '@kitajs/html'])

/**
 * Which package each config file belongs to.
 *
 * A copy of `OWNERS` in `@elvel/console`'s `config:publish`, held to it by a
 * test rather than imported: this installer depends on no framework package, so
 * that `bunx create-elvel` downloads a scaffolder and not a framework.
 *
 * `app` and `services` are absent because they belong to the application. Both
 * ship with every scaffold and neither is publishable.
 */
const CONFIG_OWNERS: Record<string, string> = {
  auth: 'auth',
  broadcasting: 'broadcasting',
  cache: 'cache',
  concurrency: 'concurrency',
  cors: 'http',
  database: 'database',
  filesystems: 'storage',
  hashing: 'hashing',
  http: 'http',
  image: 'image',
  logging: 'log',
  mail: 'mail',
  notifications: 'notifications',
  queue: 'queue',
  security: 'http',
  spa: 'spa',
  session: 'http',
  view: 'view',
  vite: 'view'
}

/**
 * Drop the config files for packages this application does not have.
 *
 * Laravel slimmed its skeleton to ten config files in 11 and left the rest to
 * `config:publish`, which is where the idea comes from — but the list is not
 * copied, because Laravel's ten are chosen for an application that always has
 * every component. Here `--kit=none` has no mailer at all, so `config/mail.ts`
 * would be settings for a package that is not installed, while `config/view.ts`
 * and `config/vite.ts` — neither of them in Laravel's ten — are read on every
 * page it serves.
 *
 * So the rule follows the providers instead: a config file stays if its package
 * is one this application actually uses. `app` and `services` always stay; they
 * belong to the application rather than to any package.
 *
 * The `withConfig` line goes with the file. Naming a config file that is not
 * there is not a missing setting — it is `Cannot find module` at boot.
 */
async function pruneConfig(target: string, present: Set<string>): Promise<void> {
  const removed: string[] = []

  for (const [name, owner] of Object.entries(CONFIG_OWNERS)) {
    if (present.has(`@elvel/${owner}`)) continue

    const path = join(target, 'config', `${name}.ts`)

    if (!(await exists(path))) continue

    await rm(path)
    removed.push(name)
  }

  if (removed.length === 0) return

  const path = join(target, 'bootstrap', 'app.ts')
  const source = await Bun.file(path).text()

  await Bun.write(
    path,
    source
      .split('\n')
      .filter((line) => !removed.some((name) => line.includes(`import('../config/${name}.ts')`)))
      .join('\n')
  )
}

/**
 * Does the scaffolded application depend on this package?
 *
 * Asked rather than inferred from the kit's name. Two places used to compare
 * `kit === 'auth' || kit === 'api'` to decide whether `auth:schema` was needed,
 * and adding a third kit that needs it — `jsx` — silently skipped both: the
 * printed steps told people to run `migrate` first, which answered
 * `Nothing to migrate` because the auth tables are generated rather than
 * shipped, and the automatic setup never generated them at all.
 *
 * `pruneDependencies` already works this way for the same reason: a fourth kit
 * gets it for free, and a kit that starts using something gets the behaviour the
 * moment it does.
 */
async function dependsOn(target: string, name: string): Promise<boolean> {
  const manifest = (await Bun.file(join(target, 'package.json'))
    .json()
    .catch(() => undefined)) as { dependencies?: Record<string, string> } | undefined

  return manifest?.dependencies?.[name] !== undefined
}

/**
 * Does one of the root manifest's `workspaces` globs match this directory?
 *
 * `workspace:*` resolves for a workspace member and nowhere else, so this is the
 * question that decides whether linking the local packages can work at all.
 * Matched with `Bun.Glob` against the path relative to the root, since that is
 * what the globs are written against.
 */
async function isWorkspaceMember(root: string, target: string): Promise<boolean> {
  const manifest = (await Bun.file(join(root, 'package.json'))
    .json()
    .catch(() => undefined)) as { workspaces?: string[] } | undefined

  const globs = manifest?.workspaces ?? []
  const step = relative(root, target).replaceAll('\\', '/')

  return globs.some((pattern) => new Bun.Glob(pattern).match(step))
}

/**
 * Fold a kit's `manifest.json` into the application's `package.json`.
 *
 * A kit is a folder copied over the template, and that is enough for source
 * files: the later copy wins. It is not enough for `package.json`, because a kit
 * shipping a whole one would duplicate the template's manifest and the two would
 * drift the first time either changed.
 *
 * `pruneDependencies` deliberately leaves `devDependencies` alone — it is the
 * toolchain, the same for every application whatever it imports — so a kit that
 * needs a *build-time* dependency has nowhere to put it. Tailwind is exactly
 * that, and this is the smallest thing that gives it somewhere: a partial
 * manifest, merged rather than copied.
 *
 * Only `devDependencies` and `scripts` are read. Runtime `dependencies` come from
 * what the code actually imports, which is a better answer than a list somebody
 * has to remember to update.
 */
async function mergeKitManifest(target: string, layers: string[]): Promise<boolean> {
  const additions: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
  } = {}

  for (const layer of layers) {
    const file = Bun.file(join(KITS_DIR, layer, 'manifest.json'))

    if (!(await file.exists())) continue

    const partial = (await file.json()) as typeof additions

    additions.dependencies = { ...additions.dependencies, ...partial.dependencies }
    additions.devDependencies = { ...additions.devDependencies, ...partial.devDependencies }
    additions.scripts = { ...additions.scripts, ...partial.scripts }
  }

  const nothing =
    Object.keys(additions.dependencies ?? {}).length === 0 &&
    Object.keys(additions.devDependencies ?? {}).length === 0 &&
    Object.keys(additions.scripts ?? {}).length === 0

  if (nothing) return false

  const path = join(target, 'package.json')
  const manifest = (await Bun.file(path).json()) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }

  // Sorted, because an unsorted manifest produces a diff nobody can read the
  // next time anything is added.
  const sort = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))

  /**
   * A runtime dependency the template cannot carry.
   *
   * `pruneDependencies` filters the template's list by what the application
   * imports; it never adds. So a kit needing a package no other kit does — the
   * auth kits render a QR code with `uqr` — has to say so here. It runs before
   * the prune, which then keeps it because the kit's own page imports it.
   */
  manifest.dependencies = sort({
    ...manifest.dependencies,
    ...additions.dependencies
  })

  manifest.devDependencies = sort({
    ...manifest.devDependencies,
    ...additions.devDependencies
  })

  // Scripts keep the template's order: it reads as a sequence — dev, build,
  // start — rather than as an index.
  manifest.scripts = { ...manifest.scripts, ...additions.scripts }

  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`)

  return true
}

/**
 * Drop the dependencies this application does not import.
 *
 * The template lists every framework package, because it has to be the union of
 * what any kit might use. What each kit *does* use is narrower — `--kit=none`
 * has no auth, no mailer and no queue — and in a framework of twenty-six
 * packages that difference is real: an unused dependency is still downloaded,
 * still resolved, still in the lockfile, and no bundler can reach it.
 *
 * Read rather than declared, deliberately. A fourth kit gets this for free, and
 * a kit that starts importing something gets the dependency the moment it does,
 * which a hand-written list per kit would not survive.
 *
 * Only `dependencies` is touched. `devDependencies` is the toolchain, the same
 * for every application whatever it imports.
 */
/**
 * A kit may ship a client of its own, and then the application owns it.
 *
 * `frontend/` in the Vue kit is a real `bun create vite` project: its own
 * manifest, its own dependencies, its own `vite.config.ts`. What it is not is a
 * second thing to install by hand — naming it in `workspaces` means one
 * `bun install` at the application root reaches it, and its dependencies land in
 * a `node_modules` of its own rather than resolving by accident through the
 * application's.
 *
 * Measured, because "accident" is the part that matters: a client that does not
 * declare `@elvel/vite` still finds it by walking up, and looks fine — until an
 * install that does not hoist, or a copy of the directory somewhere else.
 *
 * The application's own asset scripts move with it: there is no `vite.config.ts`
 * beside `elvel.ts` any more, so `vite build` there would have nothing to build.
 */
async function adoptClientProject(target: string): Promise<boolean> {
  const manifestPath = join(target, 'frontend', 'package.json')

  if (!(await exists(manifestPath))) return false

  const path = join(target, 'package.json')
  const manifest = await readJson<{
    workspaces?: string[]
    scripts?: Record<string, string>
  }>(path)

  manifest.workspaces = [...new Set([...(manifest.workspaces ?? []), 'frontend'])]
  manifest.scripts = {
    ...manifest.scripts,
    build: 'bun run --cwd frontend build',
    'dev:assets': 'bun run --cwd frontend dev'
  }

  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`)

  return true
}

async function pruneDependencies(target: string): Promise<Set<string>> {
  const imported = new Set<string>(ALWAYS_DEPENDED_ON)

  for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: target, absolute: true })) {
    const source = await Bun.file(path).text()

    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'([^'.][^']*)'/g)) {
      const specifier = match[1] as string

      // `@scope/name/sub` and `name/sub` both belong to the package in front.
      const parts = specifier.split('/')
      imported.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string))
    }
  }

  const path = join(target, 'package.json')
  const manifest = await readJson<{ dependencies?: Record<string, string> }>(path)

  manifest.dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(([name]) => imported.has(name))
  )

  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`)

  return imported
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

  /**
   * A kit names a controller by its path under `app/Http/Controllers`.
   *
   * `Auth/SignInController` rather than `SignInController`, because the auth kit
   * groups its controllers the way Laravel's does — `Auth/` and `Settings/` —
   * and a flat list of nine files in one directory is what that grouping exists
   * to avoid. The import name is the last segment; the path is the whole thing.
   */
  const declared = routes.map((line) => {
    const path = line
      .trim()
      .replace(/^\.use\(/, '')
      .replace(/\)$/, '')

    return { path, name: path.split('/').at(-1) as string }
  })

  /**
   * Inserted in sorted order, not appended.
   *
   * The scaffolded application runs the same linter this repository does, and its
   * import-sorting rule failed on a file the scaffolder itself wrote — so a new
   * project's very first `bun run lint` reported a problem the developer did not
   * create and cannot explain.
   */
  const anchor = "import PageController from '../app/Http/Controllers/PageController.ts'"
  const sorted = [...declared, { path: 'PageController', name: 'PageController' }].sort(
    /**
     * By *path*, which is what the formatter sorts by.
     *
     * Sorting by the imported name looks equivalent and is not: with the
     * controllers grouped into `Auth/` and `Settings/` the two orders differ,
     * and a new project then failed its own `bun run lint` on the very file the
     * scaffolder had written.
     */
    (one, two) => one.path.localeCompare(two.path)
  )

  const imports = sorted
    .map(({ name, path }) => `import ${name} from '../app/Http/Controllers/${path}.ts'`)
    .join('\n')

  const mounted = source
    .replace(anchor, imports)
    /**
     * One line while it fits, broken across lines when it does not.
     *
     * A scaffolded application ships the same formatter this repository uses,
     * and that formatter collapses a chain that fits and breaks one that does
     * not — so either shape is wrong for the other case, and a new project then
     * fails its own `bun run lint` on a file nobody has touched. It has happened
     * both ways round: once with one controller written across lines, and again
     * the day the auth kit went from one controller to five.
     */
    .replace("export default new Elysia({ name: 'routes:web' }).use(PageController)", () => {
      const mounts = ['.use(PageController)', ...declared.map(({ name }) => `.use(${name})`)]
      const oneLine = `export default new Elysia({ name: 'routes:web' })${mounts.join('')}`

      return oneLine.length <= 100
        ? oneLine
        : `export default new Elysia({ name: 'routes:web' })\n${mounts.map((mount) => `  ${mount}`).join('\n')}`
    })

  await Bun.write(path, `${mounted.trimEnd()}\n`)
}
