#!/usr/bin/env bun
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Register this repository's release workflow as the trusted publisher of every
 * package — twenty-seven `npm trust github` calls instead of twenty-seven visits
 * to a settings page.
 *
 * It lives here rather than in somebody's shell history because the arguments
 * have to agree with `.github/workflows/release.yml` exactly. npm matches the
 * *filename* of the workflow that asks to publish; a package registered against
 * `publish.yml` while the workflow is `release.yml` refuses every release, and
 * the error is a 403 that says nothing about filenames.
 *
 *     bun scripts/trust-publishers.ts              print what it would do
 *     bun scripts/trust-publishers.ts --register   do it
 *     bun scripts/trust-publishers.ts --list       show what each package trusts
 *
 * Two things it cannot do for you.
 *
 * **`npm trust` needs npm 11.15.0 or later**, and the npm on a machine may be
 * older, so it goes through `npx -y npm@11.15.0` rather than whatever `npm` is on
 * the path.
 *
 * **Registering a trusted publisher is an account-governance action**, so npm
 * refuses it from a granular token with 2FA bypass — measured, that is a 403
 * quoting `gh.io/npm-gat-bypass2fa-deprecation`. It needs a login session and a
 * second factor. With a security key rather than an authenticator app, npm prints
 * a URL to open in a browser, so the first call has to be run by hand:
 *
 *     npm login --auth-type=web
 *
 * After that, run this script **yourself, in a terminal** — it cannot be driven
 * from a captured shell, for the reason `run()` explains below.
 */

const ROOT = resolve(import.meta.dir, '..')

/** The workflow npm will be asked to trust. Its filename is what npm matches. */
const WORKFLOW = 'release.yml'
const REPOSITORY = 'ufhy/elvel'

/**
 * Pinned, and not to `latest` — which would be the wrong version twice over.
 *
 * `npm trust` does not exist before 11.15.0, so the npm on a machine is often too
 * old: this one has 11.6.2. And `npm@latest` is 12.0.2, whose engines are
 * `^22.22.2 || ^24.15.0 || >=26.0.0` — Node 25, an odd-numbered non-LTS release,
 * satisfies none of them, and npm 12 says so five times before doing anything.
 * 11.15.0 wants `^20.17.0 || >=22.9.0`, which is every Node this is likely to
 * meet.
 *
 * So this is the oldest version that has the command and runs where it is needed.
 * Bump it deliberately, the way `verify.yml` pins Bun.
 */
const NPM = 'npm@11.15.0'

const register = Bun.argv.includes('--register')
const listing = Bun.argv.includes('--list')

if (!(await Bun.file(join(ROOT, '.github', 'workflows', WORKFLOW)).exists())) {
  console.log(`There is no .github/workflows/${WORKFLOW}, so nothing should trust it.`)

  process.exit(1)
}

const packages: string[] = []

for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue

  const manifest = (await Bun.file(join(ROOT, 'packages', entry.name, 'package.json')).json()) as {
    name: string
    private?: boolean
  }

  if (!manifest.private) packages.push(manifest.name)
}

packages.sort()

/**
 * Registering has to run attached to the terminal, so `inherit` rather than pipe.
 *
 * npm asks for a second factor on every governance action, and with a security
 * key its way of asking is to print a URL, open a browser and *wait*. Captured
 * output means no terminal, so npm skips the waiting and fails with `EOTP` — and
 * masks the URL, which is the one thing that would have helped. Measured: piped,
 * it fails every time even with a fresh `npm login --auth-type=web` session.
 *
 * So this prints npm's own output as it goes and reads only the exit code.
 */
const run = (argv: string[], attached = false): { code: number; output: string } => {
  if (attached) {
    const result = Bun.spawnSync({ cmd: argv, cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] })

    return { code: result.exitCode ?? 1, output: '' }
  }

  const result = Bun.spawnSync({ cmd: argv, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  return {
    code: result.exitCode ?? 1,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`
      .split('\n')
      .filter((line) => !/^npm (warn|notice)/.test(line))
      .join('\n')
      .trim()
  }
}

if (listing) {
  for (const name of packages) {
    const { output } = run(['npx', '-y', NPM, 'trust', 'list', name])
    const summary = output.includes(WORKFLOW) ? `trusts ${WORKFLOW}` : output || 'nothing'

    console.log(`${name.padEnd(24)} ${summary.split('\n')[0]}`)
  }

  process.exit(0)
}

if (!register) {
  console.log(`Would register ${packages.length} packages against ${REPOSITORY} ${WORKFLOW}:\n`)

  for (const name of packages) {
    console.log(
      `  npx -y ${NPM} trust github ${name} --file ${WORKFLOW} --repo ${REPOSITORY} --allow-publish -y`
    )
  }

  console.log('\nNothing was changed. Pass --register to do it.')
  process.exit(0)
}

const failed: string[] = []

for (const name of packages) {
  console.log(`\n--- ${name}`)

  const { code } = run(
    [
      'npx',
      '-y',
      NPM,
      'trust',
      'github',
      name,
      '--file',
      WORKFLOW,
      '--repo',
      REPOSITORY,
      '--allow-publish',
      '-y'
    ],
    true
  )

  if (code === 0) {
    console.log(`registered ${name}`)

    continue
  }

  failed.push(name)

  console.log(`FAILED ${name}`)
}

console.log(`\n${packages.length - failed.length} of ${packages.length} registered`)

if (failed.length > 0) {
  console.log(`\nStill to do: ${failed.join(', ')}`)

  process.exit(1)
}
