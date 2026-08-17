#!/usr/bin/env bun
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Pack every package for npm, and check each tarball before anybody publishes it.
 *
 * Written because the last release was wrong in a way nothing could have caught.
 * That release went out under the old name: `@elyvel/core@0.1.0-alpha.6` declared
 * `dayjs` and `@sinclair/typebox` and not `@elyvel/contracts`, which its own
 * source imported — and `@elyvel/contracts` was never published at all, so the
 * package could not resolve itself. Eleven of the twenty-six were missing from
 * npm entirely while fifteen depended on them.
 *
 * That scope is gone now: after a deletion request npm took ownership of the
 * `@elyvel` names — `npm owner ls @elyvel/core` answers `npm-support` — and the
 * organisation with it, which is why this is `@elvel`.
 *
 * None of that shows up here. A workspace resolves every `@elvel/*` through the
 * root regardless of what a manifest says, so the tests pass, the playground
 * runs, and the tarball is the first place the mistake exists. So this looks at
 * the tarball.
 *
 * Packing happens inside each package directory rather than in a staging copy,
 * because that is what makes `bun pm pack` rewrite `workspace:*` into the real
 * version. Away from the workspace it would leave the protocol in place and
 * publish a manifest no installer can read.
 *
 *     bun scripts/release.ts              pack and check, publish nothing
 *     bun scripts/release.ts --publish    the same, then npm publish each tarball
 *
 * Publishing needs npm credentials, which is why it is a flag and not the
 * default. Nothing is uploaded until every check below has passed.
 */

const ROOT = resolve(import.meta.dir, '..')
const OUT = join(ROOT, 'dist-release')

const publish = Bun.argv.includes('--publish')

/**
 * A one-time password, when the account requires one to publish.
 *
 * npm refuses with `EOTP` on an account set to "auth and writes", and one code
 * has to cover all twenty-seven uploads — they run back to back inside its
 * validity window, so this is passed to each of them rather than asked for again.
 *
 * An automation token avoids the whole question and is what CI would use: npm
 * exempts those from 2FA, and then `NPM_CONFIG_TOKEN` is all this needs.
 */
const otp = Bun.argv.find((one) => one.startsWith('--otp='))?.slice('--otp='.length)
/**
 * `latest`, deliberately, even though every version so far is a prerelease.
 *
 * npm's `latest` tag is what a bare `bun add @elvel/core` installs, and it
 * currently points at `0.1.0-alpha.6` — the release whose manifest is missing its
 * own dependencies. Publishing under `--tag=alpha` would leave it pointing
 * there, so the broken version would stay the one everybody gets. Moving
 * `latest` forward is the whole point of this release.
 *
 * A second pointer can be added afterwards, which needs no republish:
 * `npm dist-tag add @elvel/core@1.0.0-alpha.1 alpha`.
 */
const tag = Bun.argv.find((one) => one.startsWith('--tag='))?.slice('--tag='.length) ?? 'latest'

type Manifest = {
  name: string
  version: string
  description: string
  files?: string[]
  dependencies?: Record<string, string>
}

/**
 * A README for the npm page, written at pack time rather than committed.
 *
 * Twenty-six near-identical files in the repository would be noise, and a
 * package page with nothing on it is worse than a short one. This is the middle:
 * the description, how to install it, and where the real documentation is.
 */
function readme(manifest: Manifest): string {
  return `# ${manifest.name}

${manifest.description}

Part of [Elvel](https://github.com/ufhy/elvel) — a Laravel-shaped framework for
Bun, built on Elysia. This package is published from the monorepo and versioned
in lockstep with the rest of it.

## Install

\`\`\`bash
bun add ${manifest.name}
\`\`\`

Most applications get it through the scaffolder instead, which installs only the
packages the chosen starter kit uses:

\`\`\`bash
bun create elvel my-app
\`\`\`

## Documentation

See the [repository](https://github.com/ufhy/elvel#readme). \`BEHAVIOURS.md\`
there records the decisions behind this package that the code cannot state on its
own.

## Licence

MIT
`
}

/** Everything a tarball has to be true about, checked after it is written. */
async function verify(tarball: string, manifest: Manifest): Promise<string[]> {
  const listing = Bun.spawnSync({ cmd: ['tar', '-tzf', tarball], stdout: 'pipe' })
  const entries = new TextDecoder().decode(listing.stdout).trim().split('\n')

  const problems: string[] = []

  for (const required of ['package/package.json', 'package/LICENSE', 'package/README.md']) {
    if (!entries.includes(required)) problems.push(`missing ${required}`)
  }

  if (!entries.some((entry) => entry.startsWith('package/src/'))) problems.push('no source')
  if (entries.some((entry) => entry.startsWith('package/test/'))) problems.push('ships test/')
  if (entries.some((entry) => entry.startsWith('package/node_modules/'))) {
    problems.push('ships node_modules/')
  }

  const packed = Bun.spawnSync({
    cmd: ['tar', '-xzOf', tarball, 'package/package.json'],
    stdout: 'pipe'
  })

  const inside = JSON.parse(new TextDecoder().decode(packed.stdout)) as Manifest

  if (inside.version !== manifest.version) {
    problems.push(`version is ${inside.version}, expected ${manifest.version}`)
  }

  /**
   * The one that would have made alpha.6 impossible.
   *
   * `workspace:*` means nothing outside this repository: `bun add` on a package
   * declaring it fails to resolve, and npm's own client reports it as an invalid
   * version range.
   */
  for (const [name, range] of Object.entries(inside.dependencies ?? {})) {
    if (range.startsWith('workspace:')) problems.push(`${name} still ${range}`)
  }

  return problems
}

const directories = (await readdir(join(ROOT, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

await rm(OUT, { recursive: true, force: true })

const licence = await Bun.file(join(ROOT, 'LICENSE')).text()
const packed: Array<{ manifest: Manifest; tarball: string; size: number }> = []
const failures: string[] = []

for (const directory of directories) {
  const dir = join(ROOT, 'packages', directory)
  const manifest = (await Bun.file(join(dir, 'package.json')).json()) as Manifest

  // Written into the package for the duration of the pack, and removed after —
  // `bun pm pack` only takes what is beside the manifest, and neither file is
  // worth twenty-six copies in git.
  await writeFile(join(dir, 'LICENSE'), licence)
  await writeFile(join(dir, 'README.md'), readme(manifest))

  try {
    const run = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--destination', OUT],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    if (run.exitCode !== 0) {
      failures.push(
        `${manifest.name}: pack failed — ${new TextDecoder().decode(run.stderr).trim()}`
      )
      continue
    }

    const slug = manifest.name.replace('@', '').replace('/', '-')
    const tarball = join(OUT, `${slug}-${manifest.version}.tgz`)

    if (!(await Bun.file(tarball).exists())) {
      failures.push(`${manifest.name}: expected ${tarball}`)
      continue
    }

    const problems = await verify(tarball, manifest)

    if (problems.length > 0) {
      failures.push(`${manifest.name}: ${problems.join('; ')}`)
      continue
    }

    packed.push({ manifest, tarball, size: Bun.file(tarball).size })
  } finally {
    await rm(join(dir, 'LICENSE'), { force: true })
    await rm(join(dir, 'README.md'), { force: true })
  }
}

for (const { manifest, size } of packed) {
  console.log(`  ${manifest.name.padEnd(24)} ${(size / 1024).toFixed(1).padStart(7)} KB`)
}

console.log(`\n${packed.length} of ${directories.length} packed into dist-release/`)

if (failures.length > 0) {
  console.log('\nRefusing to go further:')
  for (const failure of failures) console.log(`  ${failure}`)

  process.exit(1)
}

const versions = new Set(packed.map((one) => one.manifest.version))

if (versions.size !== 1) {
  console.log(`\nRefusing to publish ${versions.size} different versions: ${[...versions]}`)

  process.exit(1)
}

if (!publish) {
  console.log(`\nNothing was published. To publish all of it as \`${tag}\`:`)
  console.log(`  bun scripts/release.ts --publish --tag=${tag}`)
  console.log('\nOr one at a time, which is what --publish does in this order:')
  for (const { tarball } of packed.slice(0, 3)) {
    console.log(`  npm publish ${tarball.replace(`${ROOT}/`, '')} --access public --tag ${tag}`)
  }
  console.log(`  … and ${packed.length - 3} more`)

  process.exit(0)
}

/**
 * Ordered so a dependency is on npm before anything that needs it.
 *
 * Not strictly required — npm accepts a manifest naming a version that does not
 * exist yet — but an install attempted between the first publish and the last
 * would fail, and a publish that dies halfway leaves the registry in exactly
 * that state. Contracts and support first, then the rest alphabetically.
 */
const first = ['@elvel/contracts', '@elvel/support', '@elvel/core']
const order = [
  ...first.map((name) => packed.find((one) => one.manifest.name === name)),
  ...packed.filter((one) => !first.includes(one.manifest.name))
].filter(Boolean) as typeof packed

/**
 * The path npm will actually be able to open.
 *
 * `npm` on this machine may be the Windows binary reached through WSL interop,
 * and it reads a POSIX path as a Windows one: `/mnt/e/…/x.tgz` became
 * `E:\mnt\e\…\x.tgz` and the publish died with ENOENT before uploading
 * anything. `wslpath -w` gives the form that binary understands, and where it
 * does not exist the path is already right.
 */
function forNpm(path: string): string {
  const converted = Bun.spawnSync({ cmd: ['wslpath', '-w', path], stdout: 'pipe', stderr: 'pipe' })

  if (converted.exitCode !== 0) return path

  return new TextDecoder().decode(converted.stdout).trim() || path
}

/**
 * Is this exact version already on npm?
 *
 * Asked before every upload so a run can be repeated. One OTP covers a handful
 * of publishes and then expires, which used to mean a half-finished release and
 * a second attempt that died on `EPUBLISHCONFLICT` at the first package that had
 * made it — the very packages that succeeded were what blocked the retry. Now a
 * repeat run picks up exactly where the last one stopped.
 */
async function alreadyPublished(name: string, version: string): Promise<boolean> {
  const encoded = name.replace('/', '%2f')

  const answer = await fetch(`https://registry.npmjs.org/${encoded}/${version}`, {
    headers: { accept: 'application/json' }
  }).catch(() => undefined)

  return answer?.ok === true
}

let skipped = 0

for (const { manifest, tarball } of order) {
  if (await alreadyPublished(manifest.name, manifest.version)) {
    console.log(`already published ${manifest.name}@${manifest.version}`)
    skipped += 1

    continue
  }

  const run = Bun.spawnSync({
    cmd: [
      'npm',
      'publish',
      forNpm(tarball),
      '--access',
      'public',
      '--tag',
      tag,
      ...(otp ? [`--otp=${otp}`] : [])
    ],
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit'
  })

  if (run.exitCode !== 0) {
    console.log(`\n${manifest.name} failed to publish. Stopping — the rest are still local.`)

    process.exit(1)
  }

  console.log(`published ${manifest.name}@${manifest.version}`)
}

console.log(
  skipped > 0
    ? `\n${order.length - skipped} published as \`${tag}\`, ${skipped} were already there.`
    : `\nAll ${order.length} published as \`${tag}\`.`
)
