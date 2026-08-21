/**
 * Scaffold an application from the **registry**, not from this checkout.
 *
 * Everything else that checks `create-elvel` — `bun test`, `bun run smoke` —
 * resolves `@elvel/*` through the workspace, and a workspace member never
 * resolves a published version. That leaves a whole class of error invisible to
 * every check that runs, and it has shipped: `1.0.0-alpha.1` went out with
 * `create-elvel` writing `^0.0.1` as the range for every framework package.
 * Nothing caught it, and a second release the same day was the fix.
 *
 * Since then the check lived in a habit — run `bunx create-elvel@<version>` after
 * each release, look at the ranges, boot it. A check that exists only in
 * somebody's habit is not a check, so here it is as a script.
 *
 * It runs *after* publishing, because it needs something published to install.
 * That is late, but it is the only moment the question can be asked at all, and
 * it still lands before the release is announced.
 *
 *   bun scripts/verify-published.ts                  # the version in package.json
 *   bun scripts/verify-published.ts --version=1.0.0-alpha.9
 *   bun scripts/verify-published.ts --kits=none,auth
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = Bun.argv.slice(2)

function flag(name: string): string | undefined {
  return argv.find((token) => token.startsWith(`--${name}=`))?.slice(name.length + 3)
}

const version = flag('version') ?? (await readJson<{ version: string }>('package.json')).version
const kits = (flag('kits') ?? 'none,auth,api').split(',').filter(Boolean)

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    // The path, always: a parse error that does not say which file it read is a
    // second search on top of the first.
    throw new Error(`[${path}] could not be read as JSON — ${(error as Error).message}`)
  }
}

/**
 * Refuse to pass when there is nothing to check.
 *
 * A dry run has published nothing, so `bunx create-elvel@<version>` would either
 * install some older version or fail obscurely. Either way the honest answer is
 * to stop and say so, rather than exit zero and let a green tick mean a check
 * that never happened.
 */
async function published(name: string, wanted: string): Promise<boolean> {
  /**
   * The **packument**, not the per-version endpoint.
   *
   * `GET /pkg/1.0.0-alpha.11` answered 200 while `bun install` still said
   * `No version matching "^1.0.0-alpha.11" found for specifier "@elvel/view"
   * (but package exists)`. They are different documents with different caches,
   * and a *range* is resolved against the packument's `versions` map — so that
   * is the thing to wait for. Checking the other one made this wait for something
   * that was already true and then fail on something that was not.
   *
   * `no-store`, because a CDN copy that satisfied the first call would satisfy
   * every retry and the loop would never see the update it is waiting for.
   */
  const answer = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store'
  }).catch(() => undefined)

  if (!answer?.ok) return false

  const packument = (await answer.json().catch(() => undefined)) as
    | { versions?: Record<string, unknown> }
    | undefined

  return packument?.versions?.[wanted] !== undefined
}

/**
 * Wait for every package, not just the scaffolder.
 *
 * `npm publish` returns before a version is visible everywhere, and this runs
 * seconds later in the same job. On `alpha.10` it failed with seventy-six
 * problems that were all one thing: `No version matching "^1.0.0-alpha.10" found
 * for specifier "@elvel/cache" (but package exists)` — the package was there and
 * the version was not, yet. Running the same script by hand two minutes later
 * passed.
 *
 * So the check waits, and says what it is waiting for. Checking the scaffolder
 * alone is not enough: `create-elvel` appears first and then asks for
 * twenty-six others, so the one that lags is never the one that was asked about.
 */
async function waitForPropagation(names: string[], version: string): Promise<string[]> {
  const deadline = Date.now() + 5 * 60_000
  let pending = names

  while (pending.length > 0 && Date.now() < deadline) {
    const answers = await Promise.all(pending.map((name) => published(name, version)))
    const missing = pending.filter((_, index) => !answers[index])

    if (missing.length === 0) return []

    console.log(`  waiting for ${missing.length} package(s) to appear: ${missing.join(', ')}`)

    pending = missing
    await Bun.sleep(15_000)
  }

  return pending
}

/** Every `@elvel/*` package plus the scaffolder, from the workspace manifests. */
async function everyPackage(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const directories = await readdir('packages')
  const names: string[] = []

  for (const directory of directories) {
    const manifest = await readJson<{ name?: string; private?: boolean }>(
      join('packages', directory, 'package.json')
    ).catch(() => undefined)

    if (manifest?.name && manifest.private !== true) names.push(manifest.name)
  }

  return names
}

type Manifest = { dependencies?: Record<string, string> }

async function checkKit(kit: string, workspace: string, port: number): Promise<string[]> {
  const problems: string[] = []
  const app = join(workspace, `app-${kit}`)

  console.log(`\n─── kit ${kit} ─────────────────────────────────────────`)

  const scaffold = Bun.spawnSync({
    cmd: ['bunx', `create-elvel@${version}`, app, `--kit=${kit}`, '--install', '--force'],
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PORT: String(port) }
  })

  const log = new TextDecoder().decode(scaffold.stdout) + new TextDecoder().decode(scaffold.stderr)

  console.log(log.trimEnd())

  if (scaffold.exitCode !== 0) {
    return [`kit ${kit}: create-elvel@${version} exited ${scaffold.exitCode}`]
  }

  /**
   * A step that failed while the scaffolder carried on.
   *
   * It exits zero after a failed setup step on purpose — a half-installed
   * directory plus printed instructions beats a stack trace. That is right for a
   * person at a terminal and useless here, so the log is read: this is how
   * `kit=none` was found running `migrate` in an application that has no
   * database, reporting `Command "migrate" is not defined` under "Migrating
   * failed" on a new application's very first command.
   */
  for (const line of log.split('\n')) {
    if (/(failed|is not defined|error:)/i.test(line)) {
      problems.push(`kit ${kit}: the scaffolder said — ${plain(line)}`)
    }
  }

  // 1. What the scaffolder wrote. This is the alpha.1 bug's own ground: a range
  //    that names the wrong version, or still says `workspace:*`.
  const manifest = await readJson<Manifest>(join(app, 'package.json'))
  const declared = Object.entries(manifest.dependencies ?? {}).filter(([name]) =>
    name.startsWith('@elvel/')
  )

  if (declared.length === 0) {
    problems.push(`kit ${kit}: the scaffold declares no @elvel/* dependency at all`)
  }

  for (const [name, range] of declared) {
    if (range !== `^${version}`) {
      problems.push(`kit ${kit}: ${name} is declared as [${range}], expected [^${version}]`)
    }
  }

  // 2. What actually landed in node_modules. A correct range that resolves to
  //    something else is the same outage wearing a different hat.
  for (const [name] of declared) {
    const path = join(app, 'node_modules', name, 'package.json')
    const installed = await readJson<{ version: string }>(path).catch(() => undefined)

    if (!installed) {
      problems.push(`kit ${kit}: ${name} is declared but not installed`)
      continue
    }

    if (installed.version !== version) {
      problems.push(`kit ${kit}: ${name} resolved to ${installed.version}, not ${version}`)
    }
  }

  // 3. It boots, and answers. Ranges can be right in a scaffold that cannot
  //    start, which is how the `withConfig()` bundling bug felt from outside.
  const server = Bun.spawn({
    cmd: ['bun', 'run', 'serve'],
    cwd: app,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PORT: String(port) }
  })

  try {
    const answer = await waitForPort(port)

    if (answer === undefined) {
      problems.push(`kit ${kit}: nothing answered on :${port} within 30s`)
    } else if (answer !== 200) {
      problems.push(`kit ${kit}: GET / answered ${answer}`)
    } else {
      console.log(`  boots and answers 200 on :${port}`)
    }
  } finally {
    server.kill()
    await server.exited
  }

  return problems
}

/** Colour codes belong on a terminal, not in a failure message. */
function plain(line: string): string {
  // Built rather than written as a literal: the escape is a control character,
  // and a control character inside a regex literal is a lint error for good
  // reasons elsewhere.
  // Every CSI sequence, not only colour: the spinner's cursor moves land in the
  // same line and turn a message into `Migrating[1G[J`.
  return line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g'), '').trim()
}

async function waitForPort(port: number): Promise<number | undefined> {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    const answer = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined)

    if (answer) return answer.status

    await Bun.sleep(500)
  }

  return undefined
}

if (!(await published('create-elvel', version))) {
  console.error(
    `create-elvel@${version} is not on the registry, so there is nothing to install.\n` +
      'This runs after publishing, deliberately — it cannot check a version that does not exist.'
  )
  process.exit(1)
}

const late = await waitForPropagation(await everyPackage(), version)

if (late.length > 0) {
  console.error(
    `\n${late.length} package(s) never appeared at ${version} within five minutes: ${late.join(', ')}\n` +
      'Either the publish did not reach them, or the registry is slower than this is willing to wait.'
  )
  process.exit(1)
}

console.log(`Checking create-elvel@${version} from the registry, kits: ${kits.join(', ')}`)

const workspace = await mkdtemp(join(tmpdir(), 'elvel-published-'))
const found: string[] = []

try {
  let port = 3210

  for (const kit of kits) {
    found.push(...(await checkKit(kit, workspace, port)))
    port += 1
  }
} finally {
  await rm(workspace, { recursive: true, force: true })
}

if (found.length > 0) {
  console.error(`\n${found.length} problem(s) with what is published:\n`)
  for (const problem of found) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`\nEvery kit scaffolds from create-elvel@${version}, resolves it, and boots.`)
